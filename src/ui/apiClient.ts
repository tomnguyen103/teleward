import {
  buildBaselineCohortEntries,
  buildBaselineDailyEntries,
  computeCohortSummary,
  createSignedEntitlementToken,
  formatDailyReceipt,
  generateCohortReceipt,
  parseCohortSeed,
  verifyCohortReceipt,
  type CohortSubmissionRecord,
  type CohortSummaryMetrics,
  type DailyLeaderboardEntry,
  type EntitlementTier,
  type VerifiedCohortReceipt,
} from '../billing/cohortAndEntitlement.ts';
import { getDailySeed, getUtcDateKey } from '../engine/prng.ts';

export type {
  CohortSubmissionRecord,
  CohortSummaryMetrics,
  DailyLeaderboardEntry,
};

const OFFLINE_COHORT_STORAGE_KEY = 'teleward_cohort_roster_v1';
const OFFLINE_DAILY_LB_STORAGE_KEY = 'teleward_daily_leaderboard_v1';

export const getFallbackBaselineCohortRoster = buildBaselineCohortEntries;
export const getFallbackDailyLeaderboard = buildBaselineDailyEntries;

function resolveSafeCohortSeed(rawSeed: string): string {
  const parsed = parseCohortSeed(rawSeed);
  return parsed.valid && parsed.cohort ? parsed.cohort : 'NURS402-FALL26';
}

function readOfflineCohortCustom(cohortSeed: string): CohortSubmissionRecord[] {
  if (typeof window === 'undefined') return [];
  const safeSeed = resolveSafeCohortSeed(cohortSeed);
  try {
    const raw = window.localStorage?.getItem(OFFLINE_COHORT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, CohortSubmissionRecord[]>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.hasOwn(parsed, safeSeed) && Array.isArray(parsed[safeSeed])
      ? parsed[safeSeed]!
      : [];
  } catch {
    return [];
  }
}

function writeOfflineCohortCustom(cohortSeed: string, item: CohortSubmissionRecord): void {
  if (typeof window === 'undefined') return;
  const safeSeed = resolveSafeCohortSeed(cohortSeed);
  try {
    const raw = window.localStorage?.getItem(OFFLINE_COHORT_STORAGE_KEY);
    const parsedRaw = raw ? (JSON.parse(raw) as Record<string, CohortSubmissionRecord[]>) : {};
    const parsed =
      parsedRaw && typeof parsedRaw === 'object' && !Array.isArray(parsedRaw) ? parsedRaw : {};
    const existing =
      Object.hasOwn(parsed, safeSeed) && Array.isArray(parsed[safeSeed])
        ? parsed[safeSeed]!
        : [];
    parsed[safeSeed] = [item, ...existing].slice(0, 50);
    window.localStorage?.setItem(OFFLINE_COHORT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore localStorage quota errors
  }
}

function shouldAttemptNetworkFetch(baseUrl?: string): boolean {
  if (baseUrl !== undefined) return true;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return false;
  }
  return typeof fetch === 'function';
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 1200
): Promise<T> {
  const isJsdom =
    typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
  const controller = !isJsdom && typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error('FETCH_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetch(url, controller ? { ...init, signal: controller.signal } : init),
      timeoutPromise,
    ]);
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchCohortSubmissions(
  cohortSeed: string,
  baseUrl?: string
): Promise<{
  cohortSeed: string;
  roster: CohortSubmissionRecord[];
  summary: CohortSummaryMetrics;
  online: boolean;
}> {
  const cleanSeed = resolveSafeCohortSeed(cohortSeed);
  if (shouldAttemptNetworkFetch(baseUrl)) {
    try {
      const prefix = baseUrl ?? '';
      const data = await fetchJsonWithTimeout<{
        cohortSeed: string;
        roster: CohortSubmissionRecord[];
        summary: CohortSummaryMetrics;
      }>(`${prefix}/api/cohorts/${encodeURIComponent(cleanSeed)}/submissions`);
      return { ...data, online: true };
    } catch {
      // Fall back to deterministic local cohort roster
    }
  }

  const custom = readOfflineCohortCustom(cleanSeed);
  const roster = [...custom, ...getFallbackBaselineCohortRoster(cleanSeed)].sort(
    (a, b) => b.score - a.score
  );
  return {
    cohortSeed: cleanSeed,
    roster,
    summary: computeCohortSummary(roster),
    online: false,
  };
}

export async function submitCohortRun(
  cohortSeed: string,
  input: {
    studentAlias: string;
    score: number;
    stabilizedBeds: number;
    violations: number;
    receipt?: string;
  },
  baseUrl?: string
): Promise<{
  submission: CohortSubmissionRecord;
  summary: CohortSummaryMetrics;
  roster: CohortSubmissionRecord[];
  online: boolean;
}> {
  const cleanSeed = resolveSafeCohortSeed(cohortSeed);
  if (shouldAttemptNetworkFetch(baseUrl)) {
    try {
      const prefix = baseUrl ?? '';
      const data = await fetchJsonWithTimeout<{
        submission: CohortSubmissionRecord;
        summary: CohortSummaryMetrics;
        roster: CohortSubmissionRecord[];
      }>(`${prefix}/api/cohorts/${encodeURIComponent(cleanSeed)}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { ...data, online: true };
    } catch {
      // Fall back to offline submission persistence
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  const stabilizedBeds = Math.max(0, Math.min(4, Math.round(input.stabilizedBeds)));
  const violations = Math.max(0, Math.min(15, Math.round(input.violations)));
  const receipt = generateCohortReceipt({
    cohort: cleanSeed,
    scorePct: score,
    bedsStabilized: stabilizedBeds,
    violations,
  });

  const submission: CohortSubmissionRecord = {
    id: `local-${cleanSeed}-${Date.now()}`,
    cohortSeed: cleanSeed,
    studentAlias: input.studentAlias.trim() || 'ICU Student',
    score,
    stabilizedBeds,
    violations,
    receipt,
    submittedAt: new Date().toISOString(),
    verified: true,
  };

  writeOfflineCohortCustom(cleanSeed, submission);
  const custom = readOfflineCohortCustom(cleanSeed);
  const roster = [...custom, ...getFallbackBaselineCohortRoster(cleanSeed)].sort(
    (a, b) => b.score - a.score
  );
  return {
    submission,
    roster,
    summary: computeCohortSummary(roster),
    online: false,
  };
}

export async function verifyReceiptRemote(
  receipt: string,
  expectedCohort?: string,
  baseUrl?: string
): Promise<VerifiedCohortReceipt & { registeredInLedger: boolean; online: boolean }> {
  if (shouldAttemptNetworkFetch(baseUrl)) {
    try {
      const prefix = baseUrl ?? '';
      const data = await fetchJsonWithTimeout<
        VerifiedCohortReceipt & { registeredInLedger: boolean }
      >(`${prefix}/api/receipts/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt, expectedCohort }),
      });
      return { ...data, online: true };
    } catch {
      // Fall back to local CRC16 verification
    }
  }

  const local = verifyCohortReceipt(receipt);
  if (expectedCohort && local.cohort && local.cohort !== expectedCohort) {
    return {
      ...local,
      valid: false,
      reason: 'INVALID_COHORT',
      registeredInLedger: false,
      online: false,
    };
  }
  const roster = local.cohort
    ? [
        ...readOfflineCohortCustom(local.cohort),
        ...getFallbackBaselineCohortRoster(local.cohort),
      ]
    : [];
  const registeredInLedger = roster.some(
    (r) => r.receipt.toUpperCase() === receipt.trim().toUpperCase()
  );
  return {
    ...local,
    registeredInLedger,
    online: false,
  };
}

export async function fetchDailyChallenge(
  baseUrl?: string
): Promise<{
  dateKey: string;
  seed: number;
  leaderboard: DailyLeaderboardEntry[];
  online: boolean;
}> {
  const dateKey = getUtcDateKey();
  const seed = getDailySeed();
  if (shouldAttemptNetworkFetch(baseUrl)) {
    try {
      const prefix = baseUrl ?? '';
      const data = await fetchJsonWithTimeout<{
        dateKey: string;
        seed: number;
        leaderboard: DailyLeaderboardEntry[];
      }>(`${prefix}/api/daily`);
      return { ...data, online: true };
    } catch {
      // Fall back to local leaderboard
    }
  }

  let custom: DailyLeaderboardEntry[] = [];
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage?.getItem(OFFLINE_DAILY_LB_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DailyLeaderboardEntry[];
        if (Array.isArray(parsed)) {
          custom = parsed.filter((e) => e.dateKey === dateKey);
        }
      }
    } catch {
      custom = [];
    }
  }
  const leaderboard = [...custom, ...getFallbackDailyLeaderboard(dateKey)]
    .sort((a, b) => b.scorePct - a.scorePct)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));

  return {
    dateKey,
    seed,
    leaderboard,
    online: false,
  };
}

export async function submitDailyChallenge(
  input: {
    clinicianAlias: string;
    scorePct: number;
    bedsStabilized: number;
    violations: number;
  },
  baseUrl?: string
): Promise<{
  entry: DailyLeaderboardEntry;
  leaderboard: DailyLeaderboardEntry[];
  dateKey: string;
  online: boolean;
}> {
  const dateKey = getUtcDateKey();
  if (shouldAttemptNetworkFetch(baseUrl)) {
    try {
      const prefix = baseUrl ?? '';
      const data = await fetchJsonWithTimeout<{
        entry: DailyLeaderboardEntry;
        leaderboard: DailyLeaderboardEntry[];
        dateKey: string;
      }>(`${prefix}/api/daily/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { ...data, online: true };
    } catch {
      // Fall back to local daily submission
    }
  }

  const scorePct = Math.max(0, Math.min(100, Math.round(input.scorePct)));
  const bedsStabilized = Math.max(0, Math.min(4, Math.round(input.bedsStabilized)));
  const violations = Math.max(0, Math.min(15, Math.round(input.violations)));
  const receipt = formatDailyReceipt(dateKey, scorePct, bedsStabilized);
  const entry: DailyLeaderboardEntry = {
    clinicianAlias: input.clinicianAlias.trim() || 'ICU Operator',
    dateKey,
    scorePct,
    bedsStabilized,
    violations,
    receipt,
    submittedAt: new Date().toISOString(),
  };

  let existing: DailyLeaderboardEntry[] = [];
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage?.getItem(OFFLINE_DAILY_LB_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DailyLeaderboardEntry[];
        if (Array.isArray(parsed)) {
          existing = parsed.filter((e) => e.dateKey === dateKey);
        }
      }
      window.localStorage?.setItem(
        OFFLINE_DAILY_LB_STORAGE_KEY,
        JSON.stringify([entry, ...existing].slice(0, 30))
      );
    } catch {
      // Ignore QuotaExceededError in fallback
    }
  }

  const leaderboard = [entry, ...existing, ...getFallbackDailyLeaderboard(dateKey)]
    .sort((a, b) => b.scorePct - a.scorePct)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));

  return {
    entry,
    leaderboard,
    dateKey,
    online: false,
  };
}

export async function requestEntitlementCheckout(
  tier: 'exam_pass' | 'instructor_cohort',
  baseUrl?: string
): Promise<{
  valid: boolean;
  tier: EntitlementTier;
  token: string;
  online: boolean;
}> {
  if (shouldAttemptNetworkFetch(baseUrl)) {
    try {
      const prefix = baseUrl ?? '';
      const data = await fetchJsonWithTimeout<{
        valid: boolean;
        normalizedTier: EntitlementTier;
        token: string;
      }>(`${prefix}/api/entitlement/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      if (data.valid && data.token) {
        return {
          valid: true,
          tier: data.normalizedTier,
          token: data.token,
          online: true,
        };
      }
    } catch {
      // Fall back to local signed entitlement mint
    }
  }

  const token = createSignedEntitlementToken(tier);
  return {
    valid: true,
    tier,
    token,
    online: false,
  };
}
