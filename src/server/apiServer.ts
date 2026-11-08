import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildBaselineCohortEntries,
  buildBaselineDailyEntries,
  computeCohortSummary,
  createSignedEntitlementToken,
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
  RHYTHM_CLASSES,
  type AclsInterventionId,
  type PtbxlCaseRecord,
  type PtbxlIndexManifest,
  type RhythmClass,
} from '../types/teleward.ts';
import { ShiftController, TelewardCliValidationError, runSimulation } from '../engine/aclsEngine.ts';
import { getDailySeed, getUtcDateKey } from '../engine/prng.ts';

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
}

export interface TelewardApiOptions {
  storeFilePath?: string;
  indexJsonPath?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

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

/**
 * Replays a sequence of timestamped ACLS interventions against a deterministic ShiftController to verify submitted shift scores.
 */
function verifyActionLogReplay(
  seed: number | string,
  actionLog: unknown
):
  | { valid: true; scorePct: number; bedsStabilized: number; violations: number }
  | { valid: false; detail: string } {
  if (!Array.isArray(actionLog) || actionLog.length > 64) {
    return {
      valid: false,
      detail: 'actionLog must be an array of at most 64 intervention steps.',
    };
  }
  const numericSeed =
    typeof seed === 'number'
      ? seed >>> 0
      : (parseCohortSeed(seed).numericSeed ?? 42) >>> 0;
  const validInterventionIds = new Set<string>(ACLS_INTERVENTIONS);
  const controller = new ShiftController(numericSeed);

  let stepIdx = 0;
  for (const item of actionLog) {
    stepIdx += 1;
    if (!item || typeof item !== 'object') {
      return { valid: false, detail: 'Each actionLog entry must be an object.' };
    }
    const entry = item as Record<string, unknown>;
    const dtSec = typeof entry.dtSec === 'number' ? entry.dtSec : 0;
    if (!Number.isFinite(dtSec) || dtSec < 0 || dtSec > 300) {
      return { valid: false, detail: 'actionLog dtSec must be within 0..300 seconds.' };
    }
    let remaining = dtSec;
    while (remaining > 0) {
      const chunk = Math.min(10, remaining);
      controller.stepSeconds(chunk);
      remaining -= chunk;
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
          detail: 'actionLog entry requires bedIndex (0..3) and a valid ACLS intervention id.',
        };
      }
      controller.applyIntervention(bedIndex, action as AclsInterventionId, stepIdx * 1000);
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

        // 5. GET & POST /api/cohorts/:seed/submissions
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
            if (body.actionLog !== undefined) {
              const replay = verifyActionLogReplay(rawSeed, body.actionLog);
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
                    : `Action log replay produced score ${replay.scorePct}% (${replay.bedsStabilized} beds, ${replay.violations} violations) instead of ${score}%.`,
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

            const existing =
              Object.hasOwn(store.cohortSubmissions, rawSeed) &&
              Array.isArray(store.cohortSubmissions[rawSeed])
                ? store.cohortSubmissions[rawSeed]!
                : [];
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

        // 7. GET /api/daily & POST /api/daily/submit
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

          if (body.actionLog !== undefined) {
            const replay = verifyActionLogReplay(spec.seed, body.actionLog);
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
                  : `Action log replay produced score ${replay.scorePct}% (${replay.bedsStabilized} beds, ${replay.violations} violations) instead of ${scorePct}%.`,
              });
              return;
            }
          }
          const receipt = formatDailyReceipt(spec.dateKey, scorePct, bedsStabilized);

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
          const existing =
            Object.hasOwn(store.dailySubmissions, spec.dateKey) &&
            Array.isArray(store.dailySubmissions[spec.dateKey])
              ? store.dailySubmissions[spec.dateKey]!
              : [];
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
