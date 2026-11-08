import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTelewardServer } from '../src/server/apiServer.ts';
import { executeCli } from '../src/cli/teleward.ts';
import { generateCohortReceipt } from '../src/billing/cohortAndEntitlement.ts';
import { runSimulation } from '../src/engine/aclsEngine.ts';
import {
  fetchCohortSubmissions,
  requestEntitlementCheckout,
  submitCohortRun,
  verifyReceiptRemote,
} from '../src/ui/apiClient.ts';

describe('Ticket 01: Full-Stack Telemetry, Cohort & Entitlement REST Backend (/api/*)', () => {
  let tempDir: string;
  let storeFilePath: string;
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'teleward-api-test-'));
    storeFilePath = join(tempDir, 'store.json');
    const started = await startTelewardServer(0, { storeFilePath });
    baseUrl = `http://127.0.0.1:${started.port}`;
    closeServer = started.close;
  });

  afterEach(async () => {
    await closeServer();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('US-01.1: serves GET /api/health, GET /api/cases with ?rhythm= & ?tier= filters, and GET /api/cases/:caseId (404 on unknown)', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as {
      status: string;
      service: string;
      casesCount: number;
    };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.service).toBe('teleward-api');
    expect(healthJson.casesCount).toBe(120);

    const allCasesRes = await fetch(`${baseUrl}/api/cases`);
    expect(allCasesRes.status).toBe(200);
    const allCasesJson = (await allCasesRes.json()) as {
      total: number;
      cases: Array<{ caseId: string; rhythmClass: string; freeStarter: boolean }>;
    };
    expect(allCasesJson.total).toBe(120);
    expect(allCasesJson.cases.length).toBe(120);

    const svtFreeRes = await fetch(`${baseUrl}/api/cases?rhythm=SVT&tier=free`);
    expect(svtFreeRes.status).toBe(200);
    const svtFreeJson = (await svtFreeRes.json()) as {
      total: number;
      cases: Array<{ caseId: string; rhythmClass: string; freeStarter: boolean }>;
    };
    expect(svtFreeJson.total).toBe(2);
    expect(svtFreeJson.cases.every((c) => c.rhythmClass === 'SVT' && c.freeStarter)).toBe(true);

    const proTierRes = await fetch(`${baseUrl}/api/cases?tier=pro`);
    expect(proTierRes.status).toBe(200);
    const proTierJson = (await proTierRes.json()) as { total: number };
    expect(proTierJson.total).toBe(96);

    const singleRes = await fetch(`${baseUrl}/api/cases/ptbxl-001`);
    expect(singleRes.status).toBe(200);
    const singleJson = (await singleRes.json()) as {
      caseId: string;
      fiducials: { prMs: number; qrsMs: number; qtcMs: number };
    };
    expect(singleJson.caseId).toBe('ptbxl-001');
    expect(singleJson.fiducials.prMs).toBeGreaterThan(0);

    const missingRes = await fetch(`${baseUrl}/api/cases/ptbxl-999`);
    expect(missingRes.status).toBe(404);
  });

  it('US-01.2: executes deterministic ACLS simulation via POST /api/sim matching runSimulation and returns 400 on invalid parameters', async () => {
    const simPayload = {
      scenario: 'TORSADES',
      seed: 42,
      durationSec: 45,
      interventions: [{ action: 'magnesium_2g', atSec: 10 }],
    };
    const simRes = await fetch(`${baseUrl}/api/sim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simPayload),
    });
    expect(simRes.status).toBe(200);
    const simJson = await simRes.json();

    const expected = runSimulation({
      scenario: 'TORSADES',
      seed: 42,
      durationSec: 45,
      intervention: 'magnesium_2g',
      atSec: 10,
    });
    expect(simJson).toEqual(expected);

    const invalidDurationRes = await fetch(`${baseUrl}/api/sim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'VFIB', seed: 42, durationSec: 2400 }),
    });
    expect(invalidDurationRes.status).toBe(400);

    const invalidSeedRes = await fetch(`${baseUrl}/api/sim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'VFIB', seed: -9, durationSec: 30 }),
    });
    expect(invalidSeedRes.status).toBe(400);

    // Verify malformed URI component returns 400 INVALID_URI_PARAM instead of 500
    const badUriRes = await fetch(`${baseUrl}/api/cases/%E0%A4%A`);
    expect(badUriRes.status).toBe(400);

    // Verify short duration (<10s) with intervention defaults atSec to durationSec and succeeds
    const shortSimRes = await fetch(`${baseUrl}/api/sim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: 'VFIB',
        seed: 42,
        durationSec: 5,
        intervention: 'defibrillation',
      }),
    });
    expect(shortSimRes.status).toBe(200);
    const shortSimJson = (await shortSimRes.json()) as {
      intervention: string;
      interventionAtSec: number;
      causalTimeline: Array<{ action: string; timeSec: number }>;
    };
    expect(shortSimJson.intervention).toBe('defibrillation');
    expect(shortSimJson.interventionAtSec).toBe(5);
    expect(
      shortSimJson.causalTimeline.some((e) => e.action === 'defibrillation' && e.timeSec === 5)
    ).toBe(true);

    // Verify atSec > durationSec returns 400
    const outOfRangeAtSecRes = await fetch(`${baseUrl}/api/sim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: 'VFIB',
        seed: 42,
        durationSec: 30,
        intervene: 'defibrillation',
        atSec: 45,
      }),
    });
    expect(outOfRangeAtSecRes.status).toBe(400);
  });

  it('US-01.3: persists classroom cohort submissions in .teleward-data/store.json, computes summary stats, and rejects tampered receipts', async () => {
    const getInitial = await fetch(`${baseUrl}/api/cohorts/SPRING-2026-ICU/submissions`);
    expect(getInitial.status).toBe(200);
    const initialJson = (await getInitial.json()) as {
      cohortSeed: string;
      roster: Array<{ studentAlias: string; score: number; receipt: string }>;
      summary: { totalSubmissions: number; meanScore: number; fullStabilizationRate: number };
    };
    expect(initialJson.cohortSeed).toBe('SPRING-2026-ICU');
    expect(initialJson.roster.length).toBeGreaterThanOrEqual(3);

    const postRes = await fetch(`${baseUrl}/api/cohorts/SPRING-2026-ICU/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentAlias: 'K. Chen, RN',
        score: 100,
        stabilizedBeds: 4,
        violations: 0,
      }),
    });
    expect(postRes.status).toBe(200);
    const postJson = (await postRes.json()) as {
      submission: { studentAlias: string; score: number; receipt: string };
      summary: { totalSubmissions: number; meanScore: number; fullStabilizationRate: number };
      roster: Array<{ studentAlias: string; receipt: string }>;
    };
    expect(postJson.submission.studentAlias).toBe('K. Chen, RN');
    expect(postJson.submission.receipt).toBe(
      generateCohortReceipt({
        cohort: 'SPRING-2026-ICU',
        scorePct: 100,
        bedsStabilized: 4,
        violations: 0,
      })
    );
    expect(existsSync(storeFilePath)).toBe(true);
    expect(postJson.summary.totalSubmissions).toBe(initialJson.summary.totalSubmissions + 1);

    // Reject forged receipt in submission
    const forgedSub = await fetch(`${baseUrl}/api/cohorts/SPRING-2026-ICU/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentAlias: 'Forger',
        score: 100,
        stabilizedBeds: 4,
        violations: 0,
        receipt: 'TW-SPRING-2026-ICU-100-DEAD',
      }),
    });
    expect(forgedSub.status).toBe(400);

    // Reject invalid cohort seed or >32 char alias or reserved prototype keys
    const badSeedRes = await fetch(`${baseUrl}/api/cohorts/X/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentAlias: 'Valid Name',
        score: 80,
        stabilizedBeds: 3,
        violations: 0,
      }),
    });
    expect(badSeedRes.status).toBe(400);

    const protoSeedRes = await fetch(`${baseUrl}/api/cohorts/constructor/submissions`);
    expect(protoSeedRes.status).toBe(400);

    const protoPostRes = await fetch(`${baseUrl}/api/cohorts/__proto__/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentAlias: 'Proto',
        score: 80,
        stabilizedBeds: 3,
        violations: 0,
      }),
    });
    expect(protoPostRes.status).toBe(400);
  });

  it('US-01.4: verifies receipts via POST /api/receipts/verify, syncs daily leaderboard (/api/daily), and signs/verifies entitlements', async () => {
    const subRes = await fetch(`${baseUrl}/api/cohorts/NURS402-FALL26/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentAlias: 'L. Gomez, Paramedic',
        score: 92,
        stabilizedBeds: 4,
        violations: 1,
      }),
    });
    const subJson = (await subRes.json()) as { submission: { receipt: string } };

    const verifyOk = await fetch(`${baseUrl}/api/receipts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt: subJson.submission.receipt,
        expectedCohort: 'NURS402-FALL26',
      }),
    });
    expect(verifyOk.status).toBe(200);
    const verifyOkJson = (await verifyOk.json()) as {
      valid: boolean;
      registeredInLedger: boolean;
      scorePct: number;
    };
    expect(verifyOkJson.valid).toBe(true);
    expect(verifyOkJson.registeredInLedger).toBe(true);
    expect(verifyOkJson.scorePct).toBe(92);

    const verifyBad = await fetch(`${baseUrl}/api/receipts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: 'TW-NURS402-FALL26-100-BEEF' }),
    });
    const verifyBadJson = (await verifyBad.json()) as { valid: boolean; reason: string };
    expect(verifyBadJson.valid).toBe(false);
    expect(verifyBadJson.reason).toBe('CRC16_MISMATCH');

    // Daily Challenge endpoints
    const dailyGet = await fetch(`${baseUrl}/api/daily`);
    expect(dailyGet.status).toBe(200);
    const dailyGetJson = (await dailyGet.json()) as {
      dateKey: string;
      seed: number;
      leaderboard: Array<{ clinicianAlias: string; scorePct: number }>;
    };
    expect(dailyGetJson.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dailyGetJson.leaderboard.length).toBeGreaterThanOrEqual(3);

    const dailyPost = await fetch(`${baseUrl}/api/daily/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clinicianAlias: 'Dr. H. Tran',
        scorePct: 100,
        bedsStabilized: 4,
        violations: 0,
      }),
    });
    expect(dailyPost.status).toBe(200);
    const dailyPostJson = (await dailyPost.json()) as {
      entry: { receipt: string; clinicianAlias: string };
      leaderboard: Array<{ clinicianAlias: string }>;
    };
    expect(dailyPostJson.entry.receipt).toContain('TW-DAILY-');
    expect(dailyPostJson.leaderboard.some((e) => e.clinicianAlias === 'Dr. H. Tran')).toBe(true);

    // Entitlement checkout & verify
    const checkoutRes = await fetch(`${baseUrl}/api/entitlement/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'pro_exam_pass' }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkoutJson = (await checkoutRes.json()) as {
      valid: boolean;
      token: string;
      normalizedTier: string;
    };
    expect(checkoutJson.valid).toBe(true);
    expect(checkoutJson.normalizedTier).toBe('exam_pass');

    const entVerifyRes = await fetch(`${baseUrl}/api/entitlement/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: checkoutJson.token }),
    });
    expect(entVerifyRes.status).toBe(200);
    const entVerifyJson = (await entVerifyRes.json()) as { valid: boolean; tier: string };
    expect(entVerifyJson.valid).toBe(true);
    expect(entVerifyJson.tier).toBe('exam_pass');

    // Verify apiClient offline fallback when pointed at an unreachable base URL
    const offlineRoster = await fetchCohortSubmissions('NURS402-FALL26', 'http://127.0.0.1:1');
    expect(offlineRoster.online).toBe(false);
    expect(offlineRoster.roster.length).toBeGreaterThanOrEqual(3);

    const offlineSub = await submitCohortRun(
      'NURS402-FALL26',
      { studentAlias: 'Offline RN', score: 88, stabilizedBeds: 3, violations: 0 },
      'http://127.0.0.1:1'
    );
    expect(offlineSub.online).toBe(false);
    expect(offlineSub.submission.receipt).toContain('TW-NURS402-FALL26-88-');

    const offlineVerify = await verifyReceiptRemote(
      offlineSub.submission.receipt,
      'NURS402-FALL26',
      'http://127.0.0.1:1'
    );
    expect(offlineVerify.valid).toBe(true);

    const onlineCheckout = await requestEntitlementCheckout('exam_pass', baseUrl);
    expect(onlineCheckout.online).toBe(true);
    expect(onlineCheckout.valid).toBe(true);
    expect(onlineCheckout.tier).toBe('exam_pass');

    const offlineCheckout = await requestEntitlementCheckout(
      'instructor_cohort',
      'http://127.0.0.1:1'
    );
    expect(offlineCheckout.online).toBe(false);
    expect(offlineCheckout.valid).toBe(true);
    expect(offlineCheckout.tier).toBe('instructor_cohort');

    // Verify CLI serve subcommand validation
    expect(executeCli(['serve', '--port', '0', '--once'])).toBe(0);
    expect(executeCli(['serve', '--port', 'invalid'])).toBe(2);

    // Malformed receipt with expectedCohort must report MALFORMED_RECEIPT (not INVALID_COHORT)
    const verifyMalformedWithCohort = await fetch(`${baseUrl}/api/receipts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt: 'NOT-A-VALID-RECEIPT',
        expectedCohort: 'NURS402-FALL26',
      }),
    });
    const malformedJson = (await verifyMalformedWithCohort.json()) as {
      valid: boolean;
      reason: string;
    };
    expect(malformedJson.valid).toBe(false);
    expect(malformedJson.reason).toBe('MALFORMED_RECEIPT');

    // Lowercase receipt and expectedCohort normalize cleanly
    const verifyLower = await fetch(`${baseUrl}/api/receipts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt: subJson.submission.receipt.toLowerCase(),
        expectedCohort: 'nurs402-fall26',
      }),
    });
    const verifyLowerJson = (await verifyLower.json()) as {
      valid: boolean;
      cohort: string;
    };
    expect(verifyLowerJson.valid).toBe(true);
    expect(verifyLowerJson.cohort).toBe('NURS402-FALL26');

    // Reserved prototype-pollution cohort in receipt is rejected as INVALID_COHORT
    const verifyProtoReceipt = await fetch(`${baseUrl}/api/receipts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt: 'TW-__PROTO__-92-BEEF',
      }),
    });
    const verifyProtoJson = (await verifyProtoReceipt.json()) as {
      valid: boolean;
      reason: string;
    };
    expect(verifyProtoJson.valid).toBe(false);
    expect(verifyProtoJson.reason).toBe('INVALID_COHORT');

    // Server-side optional actionLog replay rejects forged scorePct on /api/cohorts/:seed/submissions and /api/daily/submit
    const forgedCohortRes = await fetch(`${baseUrl}/api/cohorts/NURS402-FALL26/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentAlias: 'Forged Score RN',
        score: 100,
        stabilizedBeds: 4,
        violations: 0,
        actionLog: [],
      }),
    });
    expect(forgedCohortRes.status).toBe(400);
    const forgedCohortJson = (await forgedCohortRes.json()) as { error: string };
    expect(forgedCohortJson.error).toBe('INVALID_ACTION_LOG');

    const validEmptyLogCohortRes = await fetch(
      `${baseUrl}/api/cohorts/NURS402-FALL26/submissions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentAlias: 'Verified Zero RN',
          score: 0,
          stabilizedBeds: 0,
          violations: 0,
          actionLog: [],
        }),
      }
    );
    expect(validEmptyLogCohortRes.status).toBe(200);
  });
});
