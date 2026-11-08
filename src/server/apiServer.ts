import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  buildBaselineCohortEntries,
  buildBaselineDailyEntries,
  computeCohortSummary,
  createSignedEntitlementToken,
  exportCohortRosterCsv,
  formatDailyReceipt,
  generateCohortReceipt,
  parseCohortSeed,
  verifyCohortReceipt,
  verifyEntitlementToken,
  type CohortSubmissionRecord,
  type CohortSummaryMetrics,
  type DailyLeaderboardEntry,
  type EntitlementTier,
} from '../billing/cohortAndEntitlement.ts';
import {
  ACLS_INTERVENTIONS,
  LEAD_NAMES,
  RHYTHM_CLASSES,
  type AclsInterventionId,
  type PtbxlCaseRecord,
  type PtbxlIndexManifest,
  type RhythmClass,
} from '../types/teleward.ts';
import { ShiftController, TelewardCliValidationError, runSimulation } from '../engine/aclsEngine.ts';
import { getDailySeed, getUtcDateKey } from '../engine/prng.ts';
import { getCaseWaveforms, loadPtbxlBinary, type LoadedPtbxlDataset } from '../data/ptbxlLoader.ts';

export type {
  CohortSubmissionRecord,
  CohortSummaryMetrics,
  DailyLeaderboardEntry,
};

export interface DailyChallengeSpec {
  dateKey: string;
  seed: number;
  beds: Array<{
    bedIndex: number;
    bedLabel: string;
    patientName: string;
    caseId: string;
    initialRhythm: RhythmClass;
  }>;
}

export interface TelewardStoreData {
  cohortSubmissions: Record<string, CohortSubmissionRecord[]>;
  dailySubmissions: Record<string, DailyLeaderboardEntry[]>;
  processedWebhookEvents?: string[];
  entitlements?: Record<
    string,
    { tier: EntitlementTier; token: string; eventId: string; updatedAt: string }
  >;
}

export interface TelewardApiOptions {
  storeFilePath?: string;
  indexJsonPath?: string;
  binFilePath?: string;
  webhookSecret?: string;
  enforceProEntitlement?: boolean;
  requireReplay?: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RATE_LIMIT_BUCKETS = 4096;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 240;

const rateLimitBuckets = new Map<string, { count: number; resetAtMs: number }>();

export function resolveClientIp(req: IncomingMessage): string {
  if (process.env.TELEWARD_TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    const rawXff = Array.isArray(xff) ? xff.join(',') : xff;
    if (typeof rawXff === 'string' && rawXff.trim() !== '') {
      const hops = rawXff
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      if (hops.length > 0) {
        const trustedProxyHops = Math.max(
          1,
          Number(process.env.TELEWARD_TRUSTED_PROXY_HOPS ?? 1) || 1
        );
        const targetIdx = Math.max(0, hops.length - trustedProxyHops);
        return hops[targetIdx]!;
      }
    }
  }
  return req.socket?.remoteAddress ?? '127.0.0.1';
}

export function checkRateLimit(
  ipKey: string,
  nowMs = Date.now(),
  maxRequests = RATE_LIMIT_MAX_REQUESTS
): { allowed: boolean; bucketCount: number } {
  const existing = rateLimitBuckets.get(ipKey);
  if (existing && existing.resetAtMs > nowMs) {
    existing.count += 1;
    return { allowed: existing.count <= maxRequests, bucketCount: rateLimitBuckets.size };
  }

  if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS && !rateLimitBuckets.has(ipKey)) {
    for (const [k, v] of rateLimitBuckets.entries()) {
      if (v.resetAtMs <= nowMs) {
        rateLimitBuckets.delete(k);
      }
      if (rateLimitBuckets.size < MAX_RATE_LIMIT_BUCKETS) break;
    }
    if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      let evicted = false;
      for (const [k, v] of rateLimitBuckets.entries()) {
        if (v.count < maxRequests) {
          rateLimitBuckets.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        return { allowed: false, bucketCount: rateLimitBuckets.size };
      }
    }
  }

  rateLimitBuckets.set(ipKey, { count: 1, resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS });
  return { allowed: true, bucketCount: rateLimitBuckets.size };
}

export function resetRateLimitBuckets(): void {
  rateLimitBuckets.clear();
}

let storeMutexQueue: Promise<void> = Promise.resolve();

export async function withStoreLock<T>(fn: () => T | Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  const prev = storeMutexQueue;
  storeMutexQueue = prev.then(() => next, () => next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback spin if SharedArrayBuffer is unavailable
    }
  }
}

export function renameWithRetrySync(
  tmpFile: string,
  targetFile: string,
  maxRetries = 5,
  baseDelayMs = 15,
  renameImpl: (oldPath: string, newPath: string) => void = renameSync
): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      renameImpl(tmpFile, targetFile);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as { code?: string })?.code;
      if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries - 1) {
        sleepSync(baseDelayMs * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function renameWithRetryAsync(
  tmpFile: string,
  targetFile: string,
  maxRetries = 5,
  baseDelayMs = 15,
  renameImpl: (oldPath: string, newPath: string) => void = renameSync
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      renameImpl(tmpFile, targetFile);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as { code?: string })?.code;
      if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function safeDecodeUriComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function getDailyChallengeSpec(date: Date = new Date()): DailyChallengeSpec {
  const dateKey = getUtcDateKey(date);
  const seed = getDailySeed(date);
  const controller = new ShiftController(seed);
  return {
    dateKey,
    seed,
    beds: controller.getBeds().map((b) => ({
      bedIndex: b.bedIndex,
      bedLabel: b.bedLabel,
      patientName: b.patientName,
      caseId: b.caseId,
      initialRhythm: b.vitals.rhythm,
    })),
  };
}

function readStore(storeFilePath: string, failOnReadError = false): TelewardStoreData {
  if (!existsSync(storeFilePath)) {
    return {
      cohortSubmissions: {},
      dailySubmissions: {},
      processedWebhookEvents: [],
      entitlements: {},
    };
  }
  try {
    const raw = readFileSync(storeFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TelewardStoreData>;
    return {
      cohortSubmissions:
        parsed.cohortSubmissions && typeof parsed.cohortSubmissions === 'object'
          ? parsed.cohortSubmissions
          : {},
      dailySubmissions:
        parsed.dailySubmissions && typeof parsed.dailySubmissions === 'object'
          ? parsed.dailySubmissions
          : {},
      processedWebhookEvents: Array.isArray(parsed.processedWebhookEvents)
        ? parsed.processedWebhookEvents
        : [],
      entitlements:
        parsed.entitlements && typeof parsed.entitlements === 'object'
          ? parsed.entitlements
          : {},
    };
  } catch (err) {
    if (failOnReadError) {
      throw err;
    }
    return {
      cohortSubmissions: {},
      dailySubmissions: {},
      processedWebhookEvents: [],
      entitlements: {},
    };
  }
}

async function writeStoreAsync(storeFilePath: string, data: TelewardStoreData): Promise<void> {
  mkdirSync(dirname(storeFilePath), { recursive: true });
  const tmpFile = `${storeFilePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    await renameWithRetryAsync(tmpFile, storeFilePath);
  } finally {
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile);
      }
    } catch {
      // Ignore cleanup errors on temp file
    }
  }
}

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  nowUnixSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string' || !secret) {
    return false;
  }
  let timestampStr = '';
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't' && v) timestampStr = v;
    if (k === 'v1' && v) signatures.push(v);
  }
  const timestamp = Number(timestampStr);
  if (!Number.isInteger(timestamp) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowUnixSec - timestamp) > toleranceSec) {
    return false;
  }
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedHex = createHmac('sha256', secret).update(signedPayload, 'utf-8').digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'utf-8');
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf-8');
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        rejectPromise(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (aborted) return;
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', (err) => {
      if (!aborted) {
        rejectPromise(err);
      }
    });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRawBody(req)).trim();
  if (raw === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MALFORMED_JSON');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('MALFORMED_JSON');
  }
}

/**
 * Replays a sequence of timestamped ACLS interventions against a deterministic ShiftController to verify submitted shift scores.
 */
export function verifyShiftReplay(
  seed: number | string,
  interventions: unknown,
  finalElapsedSec?: number
):
  | { valid: true; scorePct: number; bedsStabilized: number; violations: number }
  | { valid: false; detail: string } {
  if (!Array.isArray(interventions) || interventions.length > 64) {
    return {
      valid: false,
      detail: 'interventions must be an array of at most 64 intervention steps.',
    };
  }
  const numericSeed =
    typeof seed === 'number'
      ? seed >>> 0
      : (parseCohortSeed(seed).numericSeed ?? 42) >>> 0;
  const validInterventionIds = new Set<string>(ACLS_INTERVENTIONS);
  const controller = new ShiftController(numericSeed);

  let currentSec = 0;
  let stepIdx = 0;
  for (const item of interventions) {
    stepIdx += 1;
    if (!item || typeof item !== 'object') {
      return { valid: false, detail: 'Each intervention entry must be an object.' };
    }
    const entry = item as Record<string, unknown>;
    if (entry.atSec !== undefined) {
      const atSec = Number(entry.atSec);
      if (!Number.isFinite(atSec) || atSec < 0 || atSec > 300 || atSec < currentSec) {
        return {
          valid: false,
          detail: 'intervention atSec must be monotonically non-decreasing within 0..300 seconds.',
        };
      }
      let delta = atSec - currentSec;
      while (delta > 0) {
        const chunk = Math.min(10, delta);
        controller.stepSeconds(chunk);
        delta -= chunk;
      }
      currentSec = atSec;
    } else {
      const dtSec = typeof entry.dtSec === 'number' ? entry.dtSec : 0;
      if (!Number.isFinite(dtSec) || dtSec < 0 || currentSec + dtSec > 300) {
        return {
          valid: false,
          detail: 'Cumulative actionLog time must be within 0..300 seconds.',
        };
      }
      let remaining = dtSec;
      while (remaining > 0) {
        const chunk = Math.min(10, remaining);
        controller.stepSeconds(chunk);
        remaining -= chunk;
      }
      currentSec += dtSec;
    }

    if (entry.action !== undefined) {
      const bedIndex = Number(entry.bedIndex ?? 0);
      const action = String(entry.action);
      if (
        !Number.isInteger(bedIndex) ||
        bedIndex < 0 ||
        bedIndex > 3 ||
        !validInterventionIds.has(action)
      ) {
        return {
          valid: false,
          detail: 'Intervention entry requires bedIndex (0..3) and a valid ACLS intervention id.',
        };
      }
      const attemptedAtMs =
        typeof entry.attemptedAtMs === 'number' && Number.isFinite(entry.attemptedAtMs)
          ? entry.attemptedAtMs
          : stepIdx * 1000;
      controller.applyIntervention(bedIndex, action as AclsInterventionId, attemptedAtMs);
    }
  }

  if (typeof finalElapsedSec === 'number' && Number.isFinite(finalElapsedSec)) {
    if (finalElapsedSec < currentSec || finalElapsedSec > 300) {
      return {
        valid: false,
        detail: 'elapsedSec must be within currentSec..300 seconds.',
      };
    }
    let tailDelta = finalElapsedSec - currentSec;
    while (tailDelta > 0) {
      const chunk = Math.min(10, tailDelta);
      controller.stepSeconds(chunk);
      tailDelta -= chunk;
    }
  }

  const summary = controller.computeShiftScore();
  return {
    valid: true,
    scorePct: summary.scorePct,
    bedsStabilized: summary.bedsStabilized,
    violations: summary.totalViolations,
  };
}

const verifyActionLogReplay = verifyShiftReplay;

/**
 * Creates the HTTP request handler middleware for all TeleWard /api/* endpoints.
 */
export function createTelewardApiMiddleware(
  options?: TelewardApiOptions
): (req: IncomingMessage, res: ServerResponse, next?: () => void) => void {
  const storeFilePath =
    options?.storeFilePath ??
    process.env.TELEWARD_STORE_PATH ??
    resolve(process.cwd(), '.teleward-data/store.json');
  const indexJsonPath =
    options?.indexJsonPath ?? resolve(process.cwd(), 'public/data/ptbxl_index.json');
  const binFilePath =
    options?.binFilePath ?? resolve(process.cwd(), 'public/data/ptbxl_120.bin');
  const webhookSecret =
    options?.webhookSecret ??
    process.env.STRIPE_WEBHOOK_SECRET ??
    (process.env.NODE_ENV === 'production' ? '' : 'whsec_teleward_test_secret');

  let cachedManifest: PtbxlIndexManifest | null = null;
  let cachedCases: PtbxlCaseRecord[] | null = null;
  let cachedDataset: LoadedPtbxlDataset | null = null;

  const getManifest = (): PtbxlIndexManifest => {
    if (cachedManifest) return cachedManifest;
    const raw = readFileSync(indexJsonPath, 'utf-8');
    cachedManifest = JSON.parse(raw) as PtbxlIndexManifest;
    cachedCases = cachedManifest.records;
    return cachedManifest;
  };

  const getCasesCatalog = (): PtbxlCaseRecord[] => {
    if (cachedCases) return cachedCases;
    return getManifest().records;
  };

  const getLoadedDataset = (): LoadedPtbxlDataset => {
    if (cachedDataset) return cachedDataset;
    try {
      const manifest = getManifest();
      const binBuf = readFileSync(binFilePath);
      const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
      cachedDataset = loadPtbxlBinary(ab, manifest);
      return cachedDataset;
    } catch (err) {
      cachedManifest = null;
      cachedCases = null;
      cachedDataset = null;
      throw err;
    }
  };

  const extractEntitlementState = (
    req: IncomingMessage,
    parsedUrl: URL
  ): {
    hasExplicitToken: boolean;
    validProToken: boolean;
    tier: EntitlementTier;
    validCohort: boolean;
    requireEntitlement: boolean;
  } => {
    const authHeader = req.headers.authorization;
    const customTokenHeader = req.headers['x-teleward-entitlement'];
    const queryToken = parsedUrl.searchParams.get('token');
    let rawToken = '';
    if (typeof authHeader === 'string' && authHeader.trim() !== '') {
      rawToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    } else if (typeof customTokenHeader === 'string' && customTokenHeader.trim() !== '') {
      rawToken = customTokenHeader.trim();
    } else if (typeof queryToken === 'string' && queryToken.trim() !== '') {
      rawToken = queryToken.trim();
    }
    const hasExplicitToken = rawToken !== '';
    const check = verifyEntitlementToken(rawToken);
    const cohortHeader = req.headers['x-teleward-cohort'];
    const cohortQuery = parsedUrl.searchParams.get('cohort');
    const rawCohort =
      typeof cohortHeader === 'string' && cohortHeader.trim() !== ''
        ? cohortHeader.trim()
        : typeof cohortQuery === 'string'
          ? cohortQuery.trim()
          : '';
    const validCohort = rawCohort !== '' && parseCohortSeed(rawCohort).valid;
    const requireEntitlement =
      options?.enforceProEntitlement === true ||
      req.headers['x-teleward-require-entitlement'] === '1';

    return {
      hasExplicitToken,
      validProToken: check.valid,
      tier: check.tier,
      validCohort,
      requireEntitlement,
    };
  };

  const getMergedCohortRoster = (cohortSeed: string, store: TelewardStoreData): CohortSubmissionRecord[] => {
    const baseline = buildBaselineCohortEntries(cohortSeed);
    const custom =
      Object.hasOwn(store.cohortSubmissions, cohortSeed) &&
      Array.isArray(store.cohortSubmissions[cohortSeed])
        ? store.cohortSubmissions[cohortSeed]!
        : [];
    const combined = [...custom, ...baseline];
    return combined.sort((a, b) => b.score - a.score);
  };

  return (req: IncomingMessage, res: ServerResponse, next?: () => void) => {
    const rawUrl = req.url ?? '/';
    if (!rawUrl.startsWith('/api/') && rawUrl !== '/api') {
      if (next) {
        next();
        return;
      }
      sendJson(res, 404, { error: 'NOT_FOUND', status: 404, detail: 'Endpoint not found.' });
      return;
    }

    const parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    void (async () => {
      try {
        const clientIp = resolveClientIp(req);
        const rl = checkRateLimit(clientIp);
        if (!rl.allowed) {
          sendJson(res, 429, {
            error: 'RATE_LIMIT_EXCEEDED',
            status: 429,
            detail: 'Rate limit exceeded. Wait 60 seconds and retry.',
          });
          return;
        }

        // 1. GET /api/health
        if (method === 'GET' && pathname === '/api/health') {
          const cases = getCasesCatalog();
          sendJson(res, 200, {
            status: 'ok',
            service: 'teleward-api',
            casesCount: cases.length,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // 2. GET /api/cases
        if (method === 'GET' && pathname === '/api/cases') {
          const allCases = getCasesCatalog();
          const rhythmFilterRaw = parsedUrl.searchParams.get('rhythm')?.trim().toUpperCase();
          const tierFilterRaw = parsedUrl.searchParams.get('tier')?.trim().toLowerCase();

          if (
            rhythmFilterRaw &&
            rhythmFilterRaw !== 'ALL' &&
            !RHYTHM_CLASSES.includes(rhythmFilterRaw as RhythmClass)
          ) {
            sendJson(res, 400, {
              error: 'INVALID_RHYTHM_FILTER',
              status: 400,
              detail: `Unsupported rhythm filter "${rhythmFilterRaw}".`,
            });
            return;
          }

          const ent = extractEntitlementState(req, parsedUrl);
          const unentitledProAccess =
            (ent.hasExplicitToken && !ent.validProToken) ||
            (ent.requireEntitlement && !ent.validProToken && !ent.validCohort);

          if (tierFilterRaw === 'pro' && unentitledProAccess) {
            sendJson(res, 403, {
              error: 'FORBIDDEN_ENTITLEMENT',
              status: 403,
              detail: 'Pro Exam Pass or Instructor Cohort entitlement required for Pro cases.',
            });
            return;
          }

          const filtered = allCases.filter((c) => {
            if (rhythmFilterRaw && rhythmFilterRaw !== 'ALL' && c.rhythmClass !== rhythmFilterRaw) {
              return false;
            }
            if (tierFilterRaw === 'free' && !c.freeStarter) {
              return false;
            }
            if (tierFilterRaw === 'pro' && c.freeStarter) {
              return false;
            }
            if (unentitledProAccess && !c.freeStarter) {
              return false;
            }
            return true;
          });

          sendJson(res, 200, {
            total: filtered.length,
            cases: filtered,
          });
          return;
        }

        // 3a. GET /api/cases/:caseId/waveforms
        const waveformsMatch = /^\/api\/cases\/([^/]+)\/waveforms$/.exec(pathname);
        if (method === 'GET' && waveformsMatch) {
          const caseId = safeDecodeUriComponent(waveformsMatch[1]!);
          if (caseId === null) {
            sendJson(res, 400, {
              error: 'INVALID_URI_PARAM',
              status: 400,
              detail: 'Malformed URI component in caseId.',
            });
            return;
          }
          const found = getCasesCatalog().find((c) => c.caseId === caseId);
          if (!found) {
            sendJson(res, 404, {
              error: 'CASE_NOT_FOUND',
              status: 404,
              detail: `PTB-XL case "${caseId}" not found.`,
            });
            return;
          }
          if (!found.freeStarter) {
            const ent = extractEntitlementState(req, parsedUrl);
            if (!ent.validProToken && !ent.validCohort) {
              sendJson(res, 403, {
                error: 'FORBIDDEN_ENTITLEMENT',
                status: 403,
                detail: 'Pro Exam Pass or Instructor Cohort entitlement required for this case.',
              });
              return;
            }
          }
          const dataset = getLoadedDataset();
          const waveforms = getCaseWaveforms(dataset, found.caseId, 1250);
          const leadsJson: Record<string, number[]> = {};
          for (const lead of LEAD_NAMES) {
            leadsJson[lead] = Array.from(waveforms[lead]).map((v) => Number(v.toFixed(4)));
          }
          sendJson(res, 200, {
            caseId: found.caseId,
            freeStarter: found.freeStarter,
            leadCount: LEAD_NAMES.length,
            sampleRateHz: 500,
            samplesPerLead: 1250,
            leads: leadsJson,
          });
          return;
        }

        // 3b. GET /api/cases/:caseId
        const caseMatch = /^\/api\/cases\/([^/]+)$/.exec(pathname);
        if (method === 'GET' && caseMatch) {
          const caseId = safeDecodeUriComponent(caseMatch[1]!);
          if (caseId === null) {
            sendJson(res, 400, {
              error: 'INVALID_URI_PARAM',
              status: 400,
              detail: 'Malformed URI component in caseId.',
            });
            return;
          }
          const found = getCasesCatalog().find((c) => c.caseId === caseId);
          if (!found) {
            sendJson(res, 404, {
              error: 'CASE_NOT_FOUND',
              status: 404,
              detail: `PTB-XL case "${caseId}" not found.`,
            });
            return;
          }
          if (!found.freeStarter) {
            const ent = extractEntitlementState(req, parsedUrl);
            if (
              (ent.hasExplicitToken && !ent.validProToken) ||
              (ent.requireEntitlement && !ent.validProToken && !ent.validCohort)
            ) {
              sendJson(res, 403, {
                error: 'FORBIDDEN_ENTITLEMENT',
                status: 403,
                detail: 'Pro Exam Pass or Instructor Cohort entitlement required for this case.',
              });
              return;
            }
          }
          sendJson(res, 200, found);
          return;
        }

        // 4. POST /api/sim
        if (method === 'POST' && pathname === '/api/sim') {
          const body = await readJsonBody(req);
          const seedRaw = body.seed;
          const durationRaw = body.durationSec ?? 45;
          const scenarioRaw = typeof body.scenario === 'string' ? body.scenario.trim().toUpperCase() : 'VFIB';

          if (
            typeof seedRaw !== 'number' ||
            !Number.isInteger(seedRaw) ||
            seedRaw < 0 ||
            seedRaw > 4294967295
          ) {
            sendJson(res, 400, {
              error: 'INVALID_SEED',
              status: 400,
              detail: 'seed must be an unsigned 32-bit integer [0..4294967295].',
            });
            return;
          }

          if (
            typeof durationRaw !== 'number' ||
            !Number.isFinite(durationRaw) ||
            durationRaw < 1 ||
            durationRaw > 1800
          ) {
            sendJson(res, 400, {
              error: 'INVALID_DURATION',
              status: 400,
              detail: 'durationSec must be between 1 and 1800 seconds.',
            });
            return;
          }

          if (!RHYTHM_CLASSES.includes(scenarioRaw as RhythmClass)) {
            sendJson(res, 400, {
              error: 'INVALID_SCENARIO',
              status: 400,
              detail: `Unsupported scenario "${scenarioRaw}".`,
            });
            return;
          }

          let intervention: AclsInterventionId | null = null;
          let atSec: number | undefined;
          if (body.atSec !== undefined) {
            if (typeof body.atSec !== 'number' || !Number.isFinite(body.atSec)) {
              sendJson(res, 400, {
                error: 'INVALID_AT_SEC',
                status: 400,
                detail: 'atSec must be a finite number.',
              });
              return;
            }
            atSec = body.atSec;
          }

          const rawDirectIntervention =
            typeof body.intervention === 'string' && body.intervention.trim() !== ''
              ? body.intervention
              : typeof body.intervene === 'string' && body.intervene.trim() !== ''
                ? body.intervene
                : null;

          if (rawDirectIntervention !== null) {
            const cand = rawDirectIntervention.trim().toLowerCase() as AclsInterventionId;
            if (!ACLS_INTERVENTIONS.includes(cand)) {
              sendJson(res, 400, {
                error: 'INVALID_INTERVENTION',
                status: 400,
                detail: `Unsupported intervention "${rawDirectIntervention}".`,
              });
              return;
            }
            intervention = cand;
          } else if (Array.isArray(body.interventions) && body.interventions.length > 0) {
            if (body.interventions.length > 1) {
              sendJson(res, 400, {
                error: 'INVALID_INTERVENTION',
                status: 400,
                detail: 'Only a single intervention per simulation run is supported.',
              });
              return;
            }
            const first = body.interventions[0] as unknown;
            if (typeof first === 'string') {
              const cand = first.trim().toLowerCase() as AclsInterventionId;
              if (!ACLS_INTERVENTIONS.includes(cand)) {
                sendJson(res, 400, {
                  error: 'INVALID_INTERVENTION',
                  status: 400,
                  detail: `Unsupported intervention "${first}".`,
                });
                return;
              }
              intervention = cand;
            } else if (first && typeof first === 'object') {
              const obj = first as { action?: unknown; intervention?: unknown; atSec?: unknown };
              const rawAction =
                typeof obj.action === 'string'
                  ? obj.action
                  : typeof obj.intervention === 'string'
                    ? obj.intervention
                    : null;
              if (rawAction === null) {
                sendJson(res, 400, {
                  error: 'INVALID_INTERVENTION',
                  status: 400,
                  detail: 'Intervention action must be a string.',
                });
                return;
              }
              const cand = rawAction.trim().toLowerCase() as AclsInterventionId;
              if (!ACLS_INTERVENTIONS.includes(cand)) {
                sendJson(res, 400, {
                  error: 'INVALID_INTERVENTION',
                  status: 400,
                  detail: `Unsupported intervention "${rawAction}".`,
                });
                return;
              }
              intervention = cand;
              if (obj.atSec !== undefined) {
                if (typeof obj.atSec !== 'number' || !Number.isFinite(obj.atSec)) {
                  sendJson(res, 400, {
                    error: 'INVALID_AT_SEC',
                    status: 400,
                    detail: 'Intervention atSec must be a finite number.',
                  });
                  return;
                }
                atSec = obj.atSec;
              }
            } else {
              sendJson(res, 400, {
                error: 'INVALID_INTERVENTION',
                status: 400,
                detail: 'Malformed intervention entry.',
              });
              return;
            }
          }

          if (
            atSec !== undefined &&
            (!Number.isFinite(atSec) || atSec < 0 || atSec > durationRaw)
          ) {
            sendJson(res, 400, {
              error: 'INVALID_AT_SEC',
              status: 400,
              detail: `atSec must be between 0 and durationSec (${durationRaw}s).`,
            });
            return;
          }

          const transcript = runSimulation({
            scenario: scenarioRaw as RhythmClass,
            intervention,
            atSec,
            durationSec: durationRaw,
            seed: seedRaw,
          });
          sendJson(res, 200, transcript);
          return;
        }

        // 5a. GET /api/cohorts/:seed/export.csv
        const cohortCsvMatch = /^\/api\/cohorts\/([^/]+)\/export\.csv$/.exec(pathname);
        if (method === 'GET' && cohortCsvMatch) {
          const decodedSeed = safeDecodeUriComponent(cohortCsvMatch[1]!);
          const parsedSeed = decodedSeed ? parseCohortSeed(decodedSeed) : null;
          if (!parsedSeed || !parsedSeed.valid || !parsedSeed.cohort) {
            sendJson(res, 400, {
              error: 'INVALID_COHORT_SEED',
              status: 400,
              detail: 'Cohort seed must be 1..64 alphanumeric, hyphen, or underscore characters.',
            });
            return;
          }
          const rawSeed = parsedSeed.cohort.toUpperCase();
          const store = readStore(storeFilePath);
          const roster = getMergedCohortRoster(rawSeed, store);
          const csvBody = exportCohortRosterCsv(roster);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="teleward-cohort-${rawSeed}.csv"`
          );
          res.setHeader('Cache-Control', 'no-store');
          res.end(csvBody);
          return;
        }

        // 5b. GET & POST /api/cohorts/:seed/submissions
        const cohortMatch = /^\/api\/cohorts\/([^/]+)\/submissions$/.exec(pathname);
        if (cohortMatch) {
          const decodedSeed = safeDecodeUriComponent(cohortMatch[1]!);
          if (decodedSeed === null) {
            sendJson(res, 400, {
              error: 'INVALID_URI_PARAM',
              status: 400,
              detail: 'Malformed URI component in cohort seed.',
            });
            return;
          }
          const parsedSeed = parseCohortSeed(decodedSeed);
          if (
            !parsedSeed.valid ||
            !parsedSeed.cohort ||
            parsedSeed.cohort.length < 2 ||
            parsedSeed.cohort.length > 32
          ) {
            sendJson(res, 400, {
              error: 'INVALID_COHORT_SEED',
              status: 400,
              detail: 'Cohort seed must be 2..32 alphanumeric, hyphen, or underscore characters.',
            });
            return;
          }
          const rawSeed = parsedSeed.cohort.toUpperCase();

          if (method === 'GET') {
            const store = readStore(storeFilePath);
            const roster = getMergedCohortRoster(rawSeed, store);
            const summary = computeCohortSummary(roster);
            sendJson(res, 200, {
              cohortSeed: rawSeed,
              roster,
              summary,
            });
            return;
          }

          if (method === 'POST') {
            const body = await readJsonBody(req);
            const studentAlias =
              typeof body.studentAlias === 'string'
                ? body.studentAlias.replace(/[\r\n]+/g, ' ').trim()
                : '';

            const requireReplay =
              options?.requireReplay === true ||
              req.headers['x-teleward-require-replay'] === '1';

            if (
              requireReplay &&
              body.interventions === undefined &&
              body.actionLog === undefined
            ) {
              sendJson(res, 422, {
                valid: false,
                error: 'MISSING_INTERVENTION_LOG',
                status: 422,
                detail: 'Shift submission requires an interventions replay log.',
              });
              return;
            }

            let scoreRaw =
              typeof body.score === 'number'
                ? body.score
                : typeof body.scorePct === 'number'
                  ? body.scorePct
                  : Number.NaN;
            let bedsRaw =
              typeof body.stabilizedBeds === 'number'
                ? body.stabilizedBeds
                : typeof body.bedsStabilized === 'number'
                  ? body.bedsStabilized
                  : Number.NaN;
            let violationsRaw =
              typeof body.violations === 'number' ? body.violations : Number(body.violations ?? 0);
            const elapsedSecRaw =
              typeof body.elapsedSec === 'number' ? body.elapsedSec : undefined;

            if (body.interventions !== undefined) {
              const replay = verifyShiftReplay(rawSeed, body.interventions, elapsedSecRaw);
              if (!replay.valid) {
                sendJson(res, 422, {
                  valid: false,
                  error: 'REPLAY_VERIFICATION_FAILED',
                  status: 422,
                  detail: replay.detail,
                });
                return;
              }
              if (Number.isFinite(scoreRaw) && Math.round(scoreRaw) !== replay.scorePct) {
                sendJson(res, 422, {
                  valid: false,
                  error: 'SCORE_REPLAY_MISMATCH',
                  status: 422,
                  detail: 'Submitted score does not match server replay.',
                });
                return;
              }
              if (Number.isInteger(bedsRaw) && bedsRaw !== replay.bedsStabilized) {
                sendJson(res, 422, {
                  valid: false,
                  error: 'SCORE_REPLAY_MISMATCH',
                  status: 422,
                  detail: 'Submitted stabilizedBeds does not match server replay.',
                });
                return;
              }
              scoreRaw = replay.scorePct;
              bedsRaw = replay.bedsStabilized;
              violationsRaw = replay.violations;
            }

            if (
              studentAlias.length < 1 ||
              studentAlias.length > 32 ||
              /[<>]/.test(studentAlias) ||
              !Number.isFinite(scoreRaw) ||
              scoreRaw < 0 ||
              scoreRaw > 100 ||
              !Number.isInteger(bedsRaw) ||
              bedsRaw < 0 ||
              bedsRaw > 4 ||
              !Number.isInteger(violationsRaw) ||
              violationsRaw < 0 ||
              violationsRaw > 15
            ) {
              sendJson(res, 400, {
                error: 'INVALID_SUBMISSION_PAYLOAD',
                status: 400,
                detail:
                  'studentAlias (1..32 chars), score (0..100), stabilizedBeds (0..4), and violations (0..15) are required.',
              });
              return;
            }

            const score = Math.round(scoreRaw);
            if (body.actionLog !== undefined) {
              const replay = verifyActionLogReplay(rawSeed, body.actionLog, elapsedSecRaw);
              if (
                !replay.valid ||
                replay.scorePct !== score ||
                replay.bedsStabilized !== bedsRaw ||
                replay.violations !== violationsRaw
              ) {
                sendJson(res, 400, {
                  valid: false,
                  error: 'INVALID_ACTION_LOG',
                  status: 400,
                  detail: !replay.valid
                    ? replay.detail
                    : 'Submitted score does not match server replay.',
                });
                return;
              }
            }

            const expectedReceipt = generateCohortReceipt({
              cohort: rawSeed,
              scorePct: score,
              bedsStabilized: bedsRaw,
              violations: violationsRaw,
            });

            if (typeof body.receipt === 'string' && body.receipt.trim() !== '') {
              const check = verifyCohortReceipt(body.receipt.trim());
              if (
                !check.valid ||
                check.cohort !== rawSeed ||
                check.scorePct !== score ||
                body.receipt.trim().toUpperCase() !== expectedReceipt.toUpperCase()
              ) {
                const status = body.interventions !== undefined ? 422 : 400;
                sendJson(res, status, {
                  valid: false,
                  error: 'CRC16_MISMATCH',
                  status,
                  detail: 'Submitted cohort receipt failed CRC16 signature verification.',
                });
                return;
              }
            }

            const persisted = await withStoreLock(async () => {
              const store = readStore(storeFilePath, true);
              const existing =
                Object.hasOwn(store.cohortSubmissions, rawSeed) &&
                Array.isArray(store.cohortSubmissions[rawSeed])
                  ? store.cohortSubmissions[rawSeed]!
                  : [];
              const submission: CohortSubmissionRecord = {
                id: `sub-${rawSeed}-${Date.now()}-${existing.length + 1}`,
                cohortSeed: rawSeed,
                studentAlias,
                score,
                stabilizedBeds: bedsRaw,
                violations: violationsRaw,
                receipt: expectedReceipt,
                submittedAt: new Date().toISOString(),
                verified: true,
              };
              store.cohortSubmissions[rawSeed] = [submission, ...existing].slice(0, 250);
              await writeStoreAsync(storeFilePath, store);
              const roster = getMergedCohortRoster(rawSeed, store);
              const summary = computeCohortSummary(roster);
              return { submission, roster, summary };
            });

            sendJson(res, 200, {
              valid: true,
              submission: persisted.submission,
              summary: persisted.summary,
              roster: persisted.roster,
            });
            return;
          }
        }

        // 6. POST /api/receipts/verify
        if (method === 'POST' && pathname === '/api/receipts/verify') {
          const body = await readJsonBody(req);
          const receiptStr = typeof body.receipt === 'string' ? body.receipt.trim() : '';
          const expectedCohort =
            typeof body.expectedCohort === 'string' && body.expectedCohort.trim() !== ''
              ? body.expectedCohort.trim().toUpperCase()
              : null;

          const verified = verifyCohortReceipt(receiptStr);
          if (
            expectedCohort &&
            verified.cohort &&
            verified.cohort.toUpperCase() !== expectedCohort
          ) {
            sendJson(res, 200, {
              ...verified,
              valid: false,
              reason: 'INVALID_COHORT',
              receipt: receiptStr,
              registeredInLedger: false,
            });
            return;
          }

          let registeredInLedger = false;
          if (verified.valid && verified.cohort) {
            const store = readStore(storeFilePath);
            const roster = getMergedCohortRoster(verified.cohort, store);
            registeredInLedger = roster.some(
              (r) => r.receipt.toUpperCase() === receiptStr.toUpperCase()
            );
          }

          sendJson(res, 200, {
            ...verified,
            receipt: receiptStr,
            registeredInLedger,
          });
          return;
        }

        // 7. GET /api/daily & POST /api/daily/submit (plus POST /api/daily/:dateKey/submissions)
        if (method === 'GET' && pathname === '/api/daily') {
          const spec = getDailyChallengeSpec();
          const store = readStore(storeFilePath);
          const custom =
            Object.hasOwn(store.dailySubmissions, spec.dateKey) &&
            Array.isArray(store.dailySubmissions[spec.dateKey])
              ? store.dailySubmissions[spec.dateKey]!
              : [];
          const baseline = buildBaselineDailyEntries(spec.dateKey);
          const leaderboard = [...custom, ...baseline]
            .sort((a, b) => b.scorePct - a.scorePct)
            .map((entry, idx) => ({ ...entry, rank: idx + 1 }));

          sendJson(res, 200, {
            dateKey: spec.dateKey,
            seed: spec.seed,
            spec,
            leaderboard,
          });
          return;
        }

        const dailySubMatch = /^\/api\/daily\/(\d{4}-\d{2}-\d{2})\/submissions$/.exec(pathname);
        if (
          method === 'POST' &&
          (pathname === '/api/daily/submit' || dailySubMatch !== null)
        ) {
          const body = await readJsonBody(req);
          const spec = getDailyChallengeSpec();
          const targetDateKey = dailySubMatch ? dailySubMatch[1]! : spec.dateKey;
          if (dailySubMatch) {
            const parsedDate = new Date(`${targetDateKey}T00:00:00.000Z`);
            if (
              Number.isNaN(parsedDate.getTime()) ||
              getUtcDateKey(parsedDate) !== targetDateKey
            ) {
              sendJson(res, 400, {
                error: 'INVALID_DATE_KEY',
                status: 400,
                detail: `Invalid calendar date "${targetDateKey}".`,
              });
              return;
            }
          }
          const targetSeed =
            targetDateKey === spec.dateKey
              ? spec.seed
              : getDailySeed(new Date(`${targetDateKey}T00:00:00.000Z`));

          const requireReplay =
            options?.requireReplay === true ||
            req.headers['x-teleward-require-replay'] === '1';

          if (
            requireReplay &&
            body.interventions === undefined &&
            body.actionLog === undefined
          ) {
            sendJson(res, 422, {
              valid: false,
              error: 'MISSING_INTERVENTION_LOG',
              status: 422,
              detail: 'Daily shift submission requires an interventions replay log.',
            });
            return;
          }

          const aliasRaw =
            typeof body.clinicianAlias === 'string' && body.clinicianAlias.trim() !== ''
              ? body.clinicianAlias.replace(/[\r\n]+/g, ' ').trim()
              : typeof body.studentAlias === 'string' && body.studentAlias.trim() !== ''
                ? body.studentAlias.replace(/[\r\n]+/g, ' ').trim()
                : 'ICU Operator';
          let scoreRaw =
            typeof body.scorePct === 'number'
              ? body.scorePct
              : typeof body.score === 'number'
                ? body.score
                : Number.NaN;
          let bedsRaw =
            typeof body.bedsStabilized === 'number'
              ? body.bedsStabilized
              : typeof body.stabilizedBeds === 'number'
                ? body.stabilizedBeds
                : 0;
          let violationsRaw = typeof body.violations === 'number' ? body.violations : 0;
          const elapsedSecRaw =
            typeof body.elapsedSec === 'number' ? body.elapsedSec : undefined;

          if (body.interventions !== undefined) {
            const replay = verifyShiftReplay(targetSeed, body.interventions, elapsedSecRaw);
            if (!replay.valid) {
              sendJson(res, 422, {
                valid: false,
                error: 'REPLAY_VERIFICATION_FAILED',
                status: 422,
                detail: replay.detail,
              });
              return;
            }
            if (Number.isFinite(scoreRaw) && Math.round(scoreRaw) !== replay.scorePct) {
              sendJson(res, 422, {
                valid: false,
                error: 'SCORE_REPLAY_MISMATCH',
                status: 422,
                detail: 'Submitted daily score does not match server replay.',
              });
              return;
            }
            scoreRaw = replay.scorePct;
            bedsRaw = replay.bedsStabilized;
            violationsRaw = replay.violations;
          }

          if (
            aliasRaw.length > 32 ||
            /[<>]/.test(aliasRaw) ||
            !Number.isFinite(scoreRaw) ||
            scoreRaw < 0 ||
            scoreRaw > 100
          ) {
            sendJson(res, 400, {
              error: 'INVALID_DAILY_SUBMISSION',
              status: 400,
              detail: 'Valid clinicianAlias (<=32 chars) and scorePct (0..100) are required.',
            });
            return;
          }

          const scorePct = Math.round(scoreRaw);
          const bedsStabilized = Math.max(0, Math.min(4, Math.round(bedsRaw)));
          const violations = Math.max(0, Math.min(15, Math.round(violationsRaw)));

          if (body.actionLog !== undefined) {
            const replay = verifyActionLogReplay(targetSeed, body.actionLog, elapsedSecRaw);
            if (
              !replay.valid ||
              replay.scorePct !== scorePct ||
              replay.bedsStabilized !== bedsStabilized ||
              replay.violations !== violations
            ) {
              sendJson(res, 400, {
                valid: false,
                error: 'INVALID_ACTION_LOG',
                status: 400,
                detail: !replay.valid
                  ? replay.detail
                  : 'Submitted daily score does not match server replay.',
              });
              return;
            }
          }
          const receipt = formatDailyReceipt(targetDateKey, scorePct, bedsStabilized);

          const persisted = await withStoreLock(async () => {
            const store = readStore(storeFilePath, true);
            const existing =
              Object.hasOwn(store.dailySubmissions, targetDateKey) &&
              Array.isArray(store.dailySubmissions[targetDateKey])
                ? store.dailySubmissions[targetDateKey]!
                : [];
            const entry: DailyLeaderboardEntry = {
              clinicianAlias: aliasRaw,
              dateKey: targetDateKey,
              scorePct,
              bedsStabilized,
              violations,
              receipt,
              submittedAt: new Date().toISOString(),
            };
            store.dailySubmissions[targetDateKey] = [entry, ...existing].slice(0, 100);
            await writeStoreAsync(storeFilePath, store);

            const leaderboard = [
              ...store.dailySubmissions[targetDateKey]!,
              ...buildBaselineDailyEntries(targetDateKey),
            ]
              .sort((a, b) => b.scorePct - a.scorePct)
              .map((item, idx) => ({ ...item, rank: idx + 1 }));
            return { entry, leaderboard };
          });

          sendJson(res, 200, {
            dateKey: targetDateKey,
            entry: persisted.entry,
            leaderboard: persisted.leaderboard,
          });
          return;
        }

        // 8a. POST /api/billing/webhook (Stripe Webhook Signature & Idempotency)
        if (method === 'POST' && pathname === '/api/billing/webhook') {
          const rawBody = await readRawBody(req);
          const sigHeader = req.headers['stripe-signature'];
          const sigStr = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
          if (!webhookSecret || !verifyStripeWebhookSignature(rawBody, sigStr, webhookSecret)) {
            sendJson(res, 400, {
              error: 'INVALID_WEBHOOK_SIGNATURE',
              status: 400,
              detail: 'Stripe webhook signature verification failed.',
            });
            return;
          }
          let eventObj: {
            id?: unknown;
            type?: unknown;
            data?: {
              object?: {
                payment_status?: unknown;
                metadata?: { tier?: unknown; clientId?: unknown };
              };
            };
          };
          try {
            eventObj = JSON.parse(rawBody) as typeof eventObj;
          } catch {
            sendJson(res, 400, {
              error: 'MALFORMED_JSON',
              status: 400,
              detail: 'Malformed webhook JSON payload.',
            });
            return;
          }
          const eventId = typeof eventObj?.id === 'string' ? eventObj.id.trim() : '';
          if (!eventId) {
            sendJson(res, 400, {
              error: 'MISSING_EVENT_ID',
              status: 400,
              detail: 'Stripe webhook event requires a string id.',
            });
            return;
          }

          const eventType = typeof eventObj.type === 'string' ? eventObj.type.trim() : '';
          const paymentStatus =
            typeof eventObj.data?.object?.payment_status === 'string'
              ? eventObj.data.object.payment_status.trim().toLowerCase()
              : '';
          if (
            eventType.endsWith('payment_failed') ||
            paymentStatus === 'unpaid' ||
            (eventType !== '' &&
              eventType !== 'checkout.session.completed' &&
              eventType !== 'checkout.session.async_payment_succeeded')
          ) {
            sendJson(res, 400, {
              error: 'PAYMENT_NOT_COMPLETED',
              status: 400,
              detail: 'Webhook event does not represent a completed payment.',
            });
            return;
          }

          const rawTier = String(
            eventObj.data?.object?.metadata?.tier ?? 'exam_pass'
          ).toLowerCase();
          const tier: Exclude<EntitlementTier, 'free'> =
            rawTier === 'instructor_cohort' ? 'instructor_cohort' : 'exam_pass';
          const clientId = String(eventObj.data?.object?.metadata?.clientId ?? eventId).trim();
          if (
            !clientId ||
            ['__PROTO__', 'CONSTRUCTOR', 'PROTOTYPE'].includes(clientId.toUpperCase())
          ) {
            sendJson(res, 400, {
              error: 'INVALID_CLIENT_ID',
              status: 400,
              detail: 'Invalid clientId in webhook metadata.',
            });
            return;
          }

          const result = await withStoreLock(async () => {
            const store = readStore(storeFilePath, true);
            const processed = store.processedWebhookEvents ?? [];
            if (processed.includes(eventId)) {
              const existingEnt = Object.hasOwn(store.entitlements ?? {}, clientId)
                ? store.entitlements?.[clientId]
                : undefined;
              return {
                duplicate: true,
                eventId,
                token: existingEnt?.token ?? createSignedEntitlementToken(tier),
                tier: (existingEnt?.tier as Exclude<EntitlementTier, 'free'> | undefined) ?? tier,
              };
            }
            const token = createSignedEntitlementToken(tier);
            store.processedWebhookEvents = [eventId, ...processed].slice(0, 10000);
            store.entitlements = store.entitlements ?? {};
            Object.defineProperty(store.entitlements, clientId, {
              value: {
                tier,
                token,
                eventId,
                updatedAt: new Date().toISOString(),
              },
              writable: true,
              enumerable: true,
              configurable: true,
            });
            await writeStoreAsync(storeFilePath, store);
            return { duplicate: false, eventId, token, tier };
          });

          sendJson(res, 200, {
            received: true,
            duplicate: result.duplicate,
            eventId: result.eventId,
            tier: result.tier,
            token: result.token,
          });
          return;
        }

        // 8b. POST /api/entitlement/checkout & POST /api/entitlement/verify
        if (method === 'POST' && pathname === '/api/entitlement/checkout') {
          const body = await readJsonBody(req);
          const rawTier = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : '';
          const normalizedTier: Exclude<EntitlementTier, 'free'> | null =
            rawTier === 'exam_pass' || rawTier === 'pro_exam_pass'
              ? 'exam_pass'
              : rawTier === 'instructor_cohort'
                ? 'instructor_cohort'
                : null;

          if (!normalizedTier) {
            sendJson(res, 400, {
              valid: false,
              error: 'INVALID_ENTITLEMENT_TIER',
              status: 400,
              detail: 'Supported tiers: exam_pass (or pro_exam_pass), instructor_cohort.',
            });
            return;
          }

          const stripeSecretConfigured =
            typeof process.env.STRIPE_SECRET_KEY === 'string' &&
            process.env.STRIPE_SECRET_KEY.trim() !== '';
          if (stripeSecretConfigured) {
            sendJson(res, 402, {
              valid: false,
              error: 'PAYMENT_VERIFICATION_REQUIRED',
              status: 402,
              detail:
                'Live Stripe checkout is enabled; direct token minting requires a verified payment session.',
            });
            return;
          }

          const token = createSignedEntitlementToken(normalizedTier);
          sendJson(res, 200, {
            valid: true,
            status: 'approved',
            tier: rawTier,
            normalizedTier,
            token,
            checkoutUrl: `/cohort?checkout=success&tier=${normalizedTier}&token=${token}`,
          });
          return;
        }

        if (method === 'POST' && pathname === '/api/entitlement/verify') {
          const body = await readJsonBody(req);
          const token = typeof body.token === 'string' ? body.token.trim() : '';
          const check = verifyEntitlementToken(token);
          sendJson(res, 200, {
            valid: check.valid,
            tier: check.tier,
            token: check.valid ? token : null,
            reason: check.valid ? 'OK' : 'INVALID_SIGNATURE',
          });
          return;
        }

        sendJson(res, 404, {
          error: 'NOT_FOUND',
          status: 404,
          detail: `Unknown API route: ${method} ${pathname}`,
        });
      } catch (err: unknown) {
        if (err instanceof TelewardCliValidationError) {
          sendJson(res, 400, {
            error: err.problem.code ?? 'VALIDATION_ERROR',
            status: 400,
            detail: err.problem.detail,
          });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'PAYLOAD_TOO_LARGE') {
          sendJson(res, 400, {
            error: 'PAYLOAD_TOO_LARGE',
            status: 400,
            detail: 'Request body exceeds 64 KB limit.',
          });
          return;
        }
        if (msg === 'MALFORMED_JSON') {
          sendJson(res, 400, {
            error: 'MALFORMED_JSON',
            status: 400,
            detail: 'Malformed JSON body.',
          });
          return;
        }
        sendJson(res, 500, {
          error: 'INTERNAL_SERVER_ERROR',
          status: 500,
          detail: 'An unexpected internal server error occurred.',
        });
      }
    })();
  };
}

export async function startTelewardServer(
  port = 4173,
  options?: TelewardApiOptions
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const middleware = createTelewardApiMiddleware(options);
  const server = createServer((req, res) => {
    middleware(req, res);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      resolvePromise();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
