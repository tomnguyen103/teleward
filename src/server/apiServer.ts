import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createSignedEntitlementToken,
  generateCohortReceipt,
  verifyCohortReceipt,
  verifyEntitlementToken,
  type EntitlementTier,
} from '../billing/cohortAndEntitlement.ts';
import {
  ACLS_INTERVENTIONS,
  RHYTHM_CLASSES,
  type AclsInterventionId,
  type PtbxlCaseRecord,
  type PtbxlIndexManifest,
  type RhythmClass,
} from '../types/teleward.ts';
import { ShiftController, runSimulation } from '../engine/aclsEngine.ts';
import { fnv1a32, getDailySeed, getUtcDateKey, mulberry32 } from '../engine/prng.ts';

export const runAclsSimulation = runSimulation;

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
}

export interface TelewardApiOptions {
  storeFilePath?: string;
  indexJsonPath?: string;
}

const API_COHORT_SEED_REGEX = /^[A-Za-z0-9_-]{2,24}$/;
const MAX_BODY_BYTES = 64 * 1024;

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

export function buildBaselineCohortEntries(cohortSeed: string): CohortSubmissionRecord[] {
  const rng = mulberry32(fnv1a32(`BASELINE:${cohortSeed}`));
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
      cohort: cohortSeed,
      scorePct: tpl.score,
      bedsStabilized: tpl.beds,
      violations: tpl.violations,
    });
    return {
      id: `ref-${cohortSeed}-${idx + 1}`,
      cohortSeed,
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
    receipt: `TW-DAILY-${dateKey}-${t.scorePct}-${t.beds}B`,
    submittedAt: `${dateKey}T08:${String(12 + idx * 9).padStart(2, '0')}:00.000Z`,
  }));
}

export function computeCohortSummary(roster: readonly CohortSubmissionRecord[]): CohortSummaryMetrics {
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

function readStore(storeFilePath: string): TelewardStoreData {
  try {
    if (!existsSync(storeFilePath)) {
      return { cohortSubmissions: {}, dailySubmissions: {} };
    }
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
    };
  } catch {
    return { cohortSubmissions: {}, dailySubmissions: {} };
  }
}

function writeStore(storeFilePath: string, data: TelewardStoreData): void {
  mkdirSync(dirname(storeFilePath), { recursive: true });
  writeFileSync(storeFilePath, JSON.stringify(data, null, 2), 'utf-8');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw === '') {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          rejectPromise(new Error('MALFORMED_JSON'));
          return;
        }
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        rejectPromise(new Error('MALFORMED_JSON'));
      }
    });

    req.on('error', (err) => {
      if (!aborted) {
        rejectPromise(err);
      }
    });
  });
}

export function createTelewardApiMiddleware(
  options?: TelewardApiOptions
): (req: IncomingMessage, res: ServerResponse, next?: () => void) => void {
  const storeFilePath =
    options?.storeFilePath ??
    process.env.TELEWARD_STORE_PATH ??
    resolve(process.cwd(), '.teleward-data/store.json');
  const indexJsonPath =
    options?.indexJsonPath ?? resolve(process.cwd(), 'public/data/ptbxl_index.json');

  let cachedCases: PtbxlCaseRecord[] | null = null;
  const getCasesCatalog = (): PtbxlCaseRecord[] => {
    if (cachedCases) return cachedCases;
    const raw = readFileSync(indexJsonPath, 'utf-8');
    const manifest = JSON.parse(raw) as PtbxlIndexManifest;
    cachedCases = manifest.records;
    return cachedCases;
  };

  const getMergedCohortRoster = (cohortSeed: string, store: TelewardStoreData): CohortSubmissionRecord[] => {
    const baseline = buildBaselineCohortEntries(cohortSeed);
    const custom = store.cohortSubmissions[cohortSeed] ?? [];
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
            return true;
          });

          sendJson(res, 200, {
            total: filtered.length,
            cases: filtered,
          });
          return;
        }

        // 3. GET /api/cases/:caseId
        const caseMatch = /^\/api\/cases\/([^/]+)$/.exec(pathname);
        if (method === 'GET' && caseMatch) {
          const caseId = decodeURIComponent(caseMatch[1]!);
          const found = getCasesCatalog().find((c) => c.caseId === caseId);
          if (!found) {
            sendJson(res, 404, {
              error: 'CASE_NOT_FOUND',
              status: 404,
              detail: `PTB-XL case "${caseId}" not found.`,
            });
            return;
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
          let atSec: number | undefined =
            typeof body.atSec === 'number' && Number.isFinite(body.atSec) ? body.atSec : undefined;

          if (typeof body.intervention === 'string' && body.intervention.trim() !== '') {
            const cand = body.intervention.trim().toLowerCase() as AclsInterventionId;
            if (!ACLS_INTERVENTIONS.includes(cand)) {
              sendJson(res, 400, {
                error: 'INVALID_INTERVENTION',
                status: 400,
                detail: `Unsupported intervention "${body.intervention}".`,
              });
              return;
            }
            intervention = cand;
          } else if (Array.isArray(body.interventions) && body.interventions.length > 0) {
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
              const obj = first as { action?: string; intervention?: string; atSec?: number };
              const rawAction = obj.action ?? obj.intervention ?? '';
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
              if (typeof obj.atSec === 'number' && Number.isFinite(obj.atSec)) {
                atSec = obj.atSec;
              }
            }
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

        // 5. GET & POST /api/cohorts/:seed/submissions
        const cohortMatch = /^\/api\/cohorts\/([^/]+)\/submissions$/.exec(pathname);
        if (cohortMatch) {
          const rawSeed = decodeURIComponent(cohortMatch[1]!).trim();
          if (!API_COHORT_SEED_REGEX.test(rawSeed)) {
            sendJson(res, 400, {
              error: 'INVALID_COHORT_SEED',
              status: 400,
              detail: 'Cohort seed must match /^[A-Za-z0-9_-]{2,24}$/.',
            });
            return;
          }

          const store = readStore(storeFilePath);

          if (method === 'GET') {
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
              typeof body.studentAlias === 'string' ? body.studentAlias.trim() : '';
            const scoreRaw = typeof body.score === 'number' ? body.score : Number(body.scorePct);
            const bedsRaw =
              typeof body.stabilizedBeds === 'number'
                ? body.stabilizedBeds
                : Number(body.bedsStabilized);
            const violationsRaw =
              typeof body.violations === 'number' ? body.violations : Number(body.violations ?? 0);

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
                sendJson(res, 400, {
                  valid: false,
                  error: 'CRC16_MISMATCH',
                  status: 400,
                  detail: 'Submitted cohort receipt failed CRC16 signature verification.',
                });
                return;
              }
            }

            const submission: CohortSubmissionRecord = {
              id: `sub-${rawSeed}-${Date.now()}`,
              cohortSeed: rawSeed,
              studentAlias,
              score,
              stabilizedBeds: bedsRaw,
              violations: violationsRaw,
              receipt: expectedReceipt,
              submittedAt: new Date().toISOString(),
              verified: true,
            };

            const existing = store.cohortSubmissions[rawSeed] ?? [];
            store.cohortSubmissions[rawSeed] = [submission, ...existing].slice(0, 250);
            writeStore(storeFilePath, store);

            const roster = getMergedCohortRoster(rawSeed, store);
            const summary = computeCohortSummary(roster);
            sendJson(res, 200, {
              valid: true,
              submission,
              summary,
              roster,
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
              ? body.expectedCohort.trim()
              : null;

          const verified = verifyCohortReceipt(receiptStr);
          if (expectedCohort && verified.cohort !== expectedCohort) {
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

        // 7. GET /api/daily & POST /api/daily/submit
        if (method === 'GET' && pathname === '/api/daily') {
          const spec = getDailyChallengeSpec();
          const store = readStore(storeFilePath);
          const custom = store.dailySubmissions[spec.dateKey] ?? [];
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

        if (method === 'POST' && pathname === '/api/daily/submit') {
          const body = await readJsonBody(req);
          const spec = getDailyChallengeSpec();
          const aliasRaw =
            typeof body.clinicianAlias === 'string' && body.clinicianAlias.trim() !== ''
              ? body.clinicianAlias.trim()
              : 'ICU Operator';
          const scoreRaw =
            typeof body.scorePct === 'number'
              ? body.scorePct
              : typeof body.score === 'number'
                ? body.score
                : Number.NaN;
          const bedsRaw =
            typeof body.bedsStabilized === 'number'
              ? body.bedsStabilized
              : typeof body.stabilizedBeds === 'number'
                ? body.stabilizedBeds
                : 0;
          const violationsRaw = typeof body.violations === 'number' ? body.violations : 0;

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
          const receipt = `TW-DAILY-${spec.dateKey}-${scorePct}-${bedsStabilized}B`;

          const entry: DailyLeaderboardEntry = {
            clinicianAlias: aliasRaw,
            dateKey: spec.dateKey,
            scorePct,
            bedsStabilized,
            violations,
            receipt,
            submittedAt: new Date().toISOString(),
          };

          const store = readStore(storeFilePath);
          const existing = store.dailySubmissions[spec.dateKey] ?? [];
          store.dailySubmissions[spec.dateKey] = [entry, ...existing].slice(0, 100);
          writeStore(storeFilePath, store);

          const leaderboard = [...store.dailySubmissions[spec.dateKey]!, ...buildBaselineDailyEntries(spec.dateKey)]
            .sort((a, b) => b.scorePct - a.scorePct)
            .map((item, idx) => ({ ...item, rank: idx + 1 }));

          sendJson(res, 200, {
            dateKey: spec.dateKey,
            entry,
            leaderboard,
          });
          return;
        }

        // 8. POST /api/entitlement/checkout & POST /api/entitlement/verify
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
          detail: msg,
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
