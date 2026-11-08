import { computeCrc32 } from '../data/ptbxlLoader.ts';
import { fnv1a32, mulberry32 } from '../engine/prng.ts';
import type { PtbxlCaseRecord } from '../types/teleward.ts';

export type EntitlementTier = 'free' | 'exam_pass' | 'instructor_cohort';

export const COHORT_SEED_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const ENTITLEMENT_STORAGE_KEY = 'teleward_entitlement_v1';
const ENTITLEMENT_SALT = 'TELEWARD_CRC32_V1_2026';
const COHORT_CRC_SALT = 'TELEWARD_COHORT_CRC16_V1';

const RESERVED_PROTOTYPE_KEYS = new Set([
  '__PROTO__',
  'CONSTRUCTOR',
  'PROTOTYPE',
  'TOSTRING',
  'VALUEOF',
  'HASOWNPROPERTY',
  'ISPROTOTYPEOF',
  'PROPERTYISENUMERABLE',
  'TOLOCALESTRING',
]);

export interface ParsedCohortSeed {
  valid: boolean;
  cohort: string | null;
  numericSeed: number | null;
  reason?: string;
}

export function parseCohortSeed(raw: string | null | undefined): ParsedCohortSeed {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, cohort: null, numericSeed: null, reason: 'EMPTY_COHORT' };
  }
  const trimmed = raw.trim().toUpperCase();
  if (!COHORT_SEED_REGEX.test(trimmed) || RESERVED_PROTOTYPE_KEYS.has(trimmed)) {
    return {
      valid: false,
      cohort: null,
      numericSeed: null,
      reason: 'INVALID_COHORT_FORMAT',
    };
  }
  return {
    valid: true,
    cohort: trimmed,
    numericSeed: fnv1a32(trimmed),
  };
}

const utf8Encoder = new TextEncoder();

/**
 * Computes CRC-16-CCITT (poly 0x1021, init 0xFFFF) over UTF-8 string bytes.
 */
export function computeCrc16Hex(input: string): string {
  const bytes = utf8Encoder.encode(input);
  let crc = 0xffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc ^= (bytes[i]! & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface CohortReceiptPayload {
  cohort: string;
  scorePct: number;
  bedsStabilized?: number;
  violations?: number;
}

export function generateCohortReceipt(payload: CohortReceiptPayload): string {
  const parsed = parseCohortSeed(payload.cohort);
  if (!parsed.valid || !parsed.cohort) {
    throw new Error(`Invalid cohort seed "${payload.cohort}".`);
  }
  if (!Number.isFinite(payload.scorePct)) {
    throw new Error(`Invalid scorePct "${String(payload.scorePct)}".`);
  }
  const score = Math.max(0, Math.min(100, Math.round(payload.scorePct)));
  const hasAttestedCounts =
    payload.bedsStabilized !== undefined &&
    payload.violations !== undefined &&
    Number.isFinite(payload.bedsStabilized) &&
    Number.isFinite(payload.violations);
  const beds = hasAttestedCounts
    ? Math.max(0, Math.min(4, Math.round(payload.bedsStabilized!)))
    : null;
  const viol = hasAttestedCounts
    ? Math.max(0, Math.min(15, Math.round(payload.violations!)))
    : null;
  const canonical =
    beds !== null && viol !== null
      ? `${parsed.cohort}:${score}:${beds}:${viol}`
      : `${parsed.cohort}:${score}`;
  const crc16 = computeCrc16Hex(canonical);
  return `TW-${parsed.cohort}-${score}-${crc16}`;
}

export interface VerifiedCohortReceipt {
  valid: boolean;
  cohort: string | null;
  scorePct: number | null;
  bedsStabilized: number | null;
  violations: number | null;
  reason: 'OK' | 'MALFORMED_RECEIPT' | 'INVALID_COHORT' | 'CRC16_MISMATCH';
}

/**
 * Verifies a 4-segment or 5-segment TeleWard cohort completion receipt and validates its cohort seed and CRC16-CCITT signature.
 */
export function verifyCohortReceipt(receipt: string): VerifiedCohortReceipt {
  const trimmed = (receipt ?? '').trim();

  // 1. Canonical 4-segment spec format: TW-<COHORT>-<SCORE>-<CRC16>
  const match4 = /^TW-([a-zA-Z0-9_-]{1,64})-(\d{1,3})-([0-9A-Fa-f]{4})$/i.exec(trimmed);
  if (match4) {
    const parsedCohort = parseCohortSeed(match4[1]!);
    if (!parsedCohort.valid || !parsedCohort.cohort) {
      return {
        valid: false,
        cohort: null,
        scorePct: null,
        bedsStabilized: null,
        violations: null,
        reason: 'INVALID_COHORT',
      };
    }
    const cohort = parsedCohort.cohort;
    const scorePct = Number(match4[2]!);
    const providedCrc = match4[3]!.toUpperCase();

    if (scorePct < 0 || scorePct > 100) {
      return {
        valid: false,
        cohort: null,
        scorePct: null,
        bedsStabilized: null,
        violations: null,
        reason: 'MALFORMED_RECEIPT',
      };
    }

    let matchedBeds: number | null = null;
    let matchedViolations: number | null = null;
    let crcMatched = false;

    for (let b = 0; b <= 4 && !crcMatched; b++) {
      for (let v = 0; v <= 15; v++) {
        if (
          computeCrc16Hex(`${cohort}:${scorePct}:${b}:${v}`) === providedCrc ||
          computeCrc16Hex(`${COHORT_CRC_SALT}:${cohort}:${scorePct}:${b}:${v}`) === providedCrc
        ) {
          matchedBeds = b;
          matchedViolations = v;
          crcMatched = true;
          break;
        }
      }
    }

    if (
      !crcMatched &&
      (computeCrc16Hex(`${cohort}:${scorePct}`) === providedCrc ||
        computeCrc16Hex(`${COHORT_CRC_SALT}:${cohort}:${scorePct}`) === providedCrc)
    ) {
      matchedBeds = Math.min(4, Math.max(0, Math.ceil(scorePct / 25)));
      matchedViolations = Math.max(0, Math.round((matchedBeds * 25 - scorePct) / 8));
      crcMatched = true;
    }

    const fallbackBeds = Math.min(4, Math.max(0, Math.ceil(scorePct / 25)));
    const fallbackViolations = Math.max(0, Math.round((fallbackBeds * 25 - scorePct) / 8));

    if (!crcMatched) {
      return {
        valid: false,
        cohort,
        scorePct,
        bedsStabilized: fallbackBeds,
        violations: fallbackViolations,
        reason: 'CRC16_MISMATCH',
      };
    }

    return {
      valid: true,
      cohort,
      scorePct,
      bedsStabilized: matchedBeds ?? fallbackBeds,
      violations: matchedViolations ?? fallbackViolations,
      reason: 'OK',
    };
  }

  // 2. Extended 5-segment format: TW-<COHORT>-<SCORE>-<BEDS>B<VIOL>V-<CRC16>
  const match5 = /^TW-([a-zA-Z0-9_-]{1,64})-(\d{1,3})-(\d)[Bb](\d+)[Vv]-([0-9A-Fa-f]{4})$/i.exec(
    trimmed
  );
  if (!match5) {
    return {
      valid: false,
      cohort: null,
      scorePct: null,
      bedsStabilized: null,
      violations: null,
      reason: 'MALFORMED_RECEIPT',
    };
  }

  const parsedCohort5 = parseCohortSeed(match5[1]!);
  if (!parsedCohort5.valid || !parsedCohort5.cohort) {
    return {
      valid: false,
      cohort: null,
      scorePct: null,
      bedsStabilized: null,
      violations: null,
      reason: 'INVALID_COHORT',
    };
  }
  const cohort = parsedCohort5.cohort;
  const scorePct = Number(match5[2]!);
  const bedsStabilized = Number(match5[3]!);
  const violations = Number(match5[4]!);
  const providedCrc = match5[5]!.toUpperCase();

  if (scorePct < 0 || scorePct > 100 || bedsStabilized < 0 || bedsStabilized > 4) {
    return {
      valid: false,
      cohort: null,
      scorePct: null,
      bedsStabilized: null,
      violations: null,
      reason: 'MALFORMED_RECEIPT',
    };
  }

  const expectedCandidates = [
    computeCrc16Hex(`${COHORT_CRC_SALT}:${cohort}:${scorePct}:${bedsStabilized}:${violations}`),
    computeCrc16Hex(`${cohort}:${scorePct}:${bedsStabilized}:${violations}`),
  ];
  if (!expectedCandidates.includes(providedCrc)) {
    return {
      valid: false,
      cohort,
      scorePct,
      bedsStabilized,
      violations,
      reason: 'CRC16_MISMATCH',
    };
  }

  return {
    valid: true,
    cohort,
    scorePct,
    bedsStabilized,
    violations,
    reason: 'OK',
  };
}

function encodeAscii(str: string): Uint8Array {
  return utf8Encoder.encode(str);
}

export function createSignedEntitlementToken(
  tier: Exclude<EntitlementTier, 'free'>
): string {
  const payload = `${ENTITLEMENT_SALT}:${tier}`;
  const crc = computeCrc32(encodeAscii(payload))
    .toString(16)
    .padStart(8, '0');
  return `tw_pro_${tier}_${crc}`;
}

export function verifyEntitlementToken(token: string | null | undefined): {
  valid: boolean;
  tier: EntitlementTier;
} {
  if (!token || typeof token !== 'string') {
    return { valid: false, tier: 'free' };
  }
  const match = /^tw_pro_(exam_pass|instructor_cohort)_([0-9a-f]{8})$/i.exec(token.trim());
  if (!match) {
    return { valid: false, tier: 'free' };
  }
  const tier = match[1]!.toLowerCase() as Exclude<EntitlementTier, 'free'>;
  const sig = match[2]!.toLowerCase();
  const expected = createSignedEntitlementToken(tier).slice(-8).toLowerCase();

  if (sig !== expected) {
    return { valid: false, tier: 'free' };
  }
  return { valid: true, tier };
}

export interface StoredEntitlementState {
  tier: EntitlementTier;
  token: string | null;
  valid: boolean;
}

export function readEntitlementFromStorage(): StoredEntitlementState {
  if (typeof window === 'undefined') {
    return { tier: 'free', token: null, valid: true };
  }
  try {
    const storage = window.localStorage;
    if (!storage) {
      return { tier: 'free', token: null, valid: true };
    }
    const raw = storage.getItem(ENTITLEMENT_STORAGE_KEY);
    if (!raw) {
      return { tier: 'free', token: null, valid: true };
    }
    const parsed = JSON.parse(raw) as { tier?: string; token?: string };
    const check = verifyEntitlementToken(parsed.token);
    if (!check.valid) {
      storage.removeItem(ENTITLEMENT_STORAGE_KEY);
      return { tier: 'free', token: null, valid: false };
    }
    return { tier: check.tier, token: parsed.token ?? null, valid: true };
  } catch {
    return { tier: 'free', token: null, valid: false };
  }
}

export function activateEntitlement(
  tier: Exclude<EntitlementTier, 'free'>,
  token?: string,
  options?: { allowSandboxMint?: boolean }
): StoredEntitlementState {
  if (!token && options?.allowSandboxMint !== true) {
    return { tier: 'free', token: null, valid: false };
  }
  const signedToken = token ?? createSignedEntitlementToken(tier);
  const check = verifyEntitlementToken(signedToken);
  if (!check.valid || check.tier !== tier) {
    return { tier: 'free', token: null, valid: false };
  }
  if (typeof window !== 'undefined') {
    try {
      const storage = window.localStorage;
      storage?.setItem(
        ENTITLEMENT_STORAGE_KEY,
        JSON.stringify({ tier: check.tier, token: signedToken })
      );
    } catch {
      // Ignore storage quota errors while preserving in-memory return
    }
  }
  return { tier: check.tier, token: signedToken, valid: true };
}

export function canAccessCaseWithEntitlement(
  record: PtbxlCaseRecord,
  tier: EntitlementTier,
  cohortSeed: string | null
): boolean {
  if (record.freeStarter) return true;
  if (tier === 'exam_pass' || tier === 'instructor_cohort') return true;
  if (cohortSeed && parseCohortSeed(cohortSeed).valid) return true;
  return false;
}

export interface CohortSubmissionRecord {
  id: string;
  cohortSeed: string;
  studentAlias: string;
  score: number;
  stabilizedBeds: number;
  violations: number;
  receipt: string;
  submittedAt: string;
  verified: boolean;
}

export interface CohortSummaryMetrics {
  totalSubmissions: number;
  meanScore: number;
  fullStabilizationRate: number;
}

export interface DailyLeaderboardEntry {
  rank?: number;
  clinicianAlias: string;
  dateKey: string;
  scorePct: number;
  bedsStabilized: number;
  violations: number;
  receipt: string;
  submittedAt: string;
}

export function formatDailyReceipt(
  dateKey: string,
  scorePct: number,
  bedsStabilized: number
): string {
  return `TW-DAILY-${dateKey}-${Math.round(scorePct)}-${Math.round(bedsStabilized)}B`;
}

export function buildBaselineCohortEntries(cohortSeed: string): CohortSubmissionRecord[] {
  const parsed = parseCohortSeed(cohortSeed);
  const safeSeed = parsed.valid && parsed.cohort ? parsed.cohort : 'NURS402-FALL26';
  const rng = mulberry32(fnv1a32(`BASELINE:${safeSeed}`));
  const aliases = ['R. Patel, BSN RN', 'J. Kim, EM-R2', 'A. Morales, NRP'];
  const templates = [
    { beds: 4, violations: 0, score: 100 },
    { beds: 4, violations: 1, score: 92 },
    { beds: 3, violations: 0, score: 75 },
  ];
  return aliases.map((alias, idx) => {
    const tpl = templates[idx]!;
    const jitterMin = Math.floor(rng() * 25) + 5;
    const receipt = generateCohortReceipt({
      cohort: safeSeed,
      scorePct: tpl.score,
      bedsStabilized: tpl.beds,
      violations: tpl.violations,
    });
    return {
      id: `ref-${safeSeed}-${idx + 1}`,
      cohortSeed: safeSeed,
      studentAlias: alias,
      score: tpl.score,
      stabilizedBeds: tpl.beds,
      violations: tpl.violations,
      receipt,
      submittedAt: new Date(Date.UTC(2026, 2, 15, 14, jitterMin, 0)).toISOString(),
      verified: true,
    };
  });
}

export function buildBaselineDailyEntries(dateKey: string): DailyLeaderboardEntry[] {
  const templates = [
    { alias: 'Dr. M. Al-Mansoor (ICU)', scorePct: 100, beds: 4, violations: 0 },
    { alias: 'C. Lindholm, CCRN', scorePct: 92, beds: 4, violations: 1 },
    { alias: 'T. Nguyen, Flight Paramedic', scorePct: 84, beds: 4, violations: 2 },
  ];
  return templates.map((t, idx) => ({
    rank: idx + 1,
    clinicianAlias: t.alias,
    dateKey,
    scorePct: t.scorePct,
    bedsStabilized: t.beds,
    violations: t.violations,
    receipt: formatDailyReceipt(dateKey, t.scorePct, t.beds),
    submittedAt: `${dateKey}T08:${String(12 + idx * 9).padStart(2, '0')}:00.000Z`,
  }));
}

export function computeCohortSummary(
  roster: readonly CohortSubmissionRecord[]
): CohortSummaryMetrics {
  if (roster.length === 0) {
    return { totalSubmissions: 0, meanScore: 0, fullStabilizationRate: 0 };
  }
  const totalScore = roster.reduce((acc, r) => acc + r.score, 0);
  const fullStabCount = roster.filter((r) => r.stabilizedBeds === 4).length;
  return {
    totalSubmissions: roster.length,
    meanScore: Math.round(totalScore / roster.length),
    fullStabilizationRate: Math.round((fullStabCount / roster.length) * 100),
  };
}
