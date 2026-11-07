import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPtbxlBinary } from '../src/data/ptbxlLoader.ts';
import {
  parseCohortSeed,
  generateCohortReceipt,
  verifyCohortReceipt,
  createSignedEntitlementToken,
  verifyEntitlementToken,
  activateEntitlement,
  readEntitlementFromStorage,
  canAccessCaseWithEntitlement,
} from '../src/billing/cohortAndEntitlement.ts';
import { App } from '../src/App.tsx';

const WORKSPACE_ROOT = resolve(process.cwd());
const BIN_BUF = readFileSync(resolve(WORKSPACE_ROOT, 'public/data/ptbxl_120.bin'));
const INDEX_JSON = JSON.parse(
  readFileSync(resolve(WORKSPACE_ROOT, 'public/data/ptbxl_index.json'), 'utf-8')
);
const DATASET = loadPtbxlBinary(
  BIN_BUF.buffer.slice(BIN_BUF.byteOffset, BIN_BUF.byteOffset + BIN_BUF.byteLength),
  INDEX_JSON
);

describe('US-04.6 & US-05: Stripe Checkout Pro Exam Pass ($19) & Stateless ?cohort=<seed> Instructor Mode', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('US-04.6: blocks locked Pro exam cases (ptbxl-025..ptbxl-120) on free tier without cohort seed and unlocks when Pro or cohort is active', () => {
    const starterCase = DATASET.records[0]!; // ptbxl-001 (freeStarter = true)
    const proCase = DATASET.records[50]!; // ptbxl-051 (freeStarter = false)

    expect(canAccessCaseWithEntitlement(starterCase, 'free', null)).toBe(true);
    expect(canAccessCaseWithEntitlement(proCase, 'free', null)).toBe(false);
    expect(canAccessCaseWithEntitlement(proCase, 'exam_pass', null)).toBe(true);
    expect(canAccessCaseWithEntitlement(proCase, 'instructor_cohort', null)).toBe(true);
    expect(canAccessCaseWithEntitlement(proCase, 'free', 'NURS402-FALL26')).toBe(true);

    // Mount /caliper/ptbxl-051 on free tier -> renders Pro Exam Bank gate with zero answer key leakage
    const { getByTestId, container } = render(
      <App initialPath="/caliper/ptbxl-051" preloadedDataset={DATASET} />
    );
    expect(getByTestId('pro-case-gate-panel')).toBeTruthy();
    expect(container.textContent).not.toContain('OVERALL PASS');
    // Inspector must not leak locked case fiducials or rhythm diagnosis
    const inspectorText = getByTestId('causal-timeline-inspector').textContent ?? '';
    expect(inspectorText).not.toContain('PTB-XL Cardiologist Fiducial Ground Truth');
    expect(inspectorText).not.toContain('ptbxl-051');
  });

  it('US-05.1: synchronizes ?cohort=NURS402-FALL26 across students and verifies CRC16 completion receipts on /cohort', () => {
    const parsedA = parseCohortSeed('NURS402-FALL26');
    const parsedB = parseCohortSeed('NURS402-FALL26');
    expect(parsedA.valid).toBe(true);
    expect(parsedA.numericSeed).toBe(parsedB.numericSeed);

    const receipt = generateCohortReceipt({
      cohort: 'NURS402-FALL26',
      scorePct: 92,
      bedsStabilized: 4,
      violations: 1,
    });
    expect(receipt.startsWith('TW-NURS402-FALL26-92-')).toBe(true);
    expect(/^TW-NURS402-FALL26-92-[0-9A-F]{4}$/.test(receipt)).toBe(true);

    const verification = verifyCohortReceipt(receipt);
    expect(verification.valid).toBe(true);
    expect(verification.cohort).toBe('NURS402-FALL26');
    expect(verification.scorePct).toBe(92);
    expect(verification.bedsStabilized).toBe(4);
    expect(verification.violations).toBe(1);

    // Verify UI flow on /cohort
    const { getByTestId } = render(
      <App initialPath="/cohort" preloadedDataset={DATASET} />
    );
    const verifierInput = getByTestId('cohort-receipt-input') as HTMLInputElement;
    fireEvent.input(verifierInput, { target: { value: receipt } });
    fireEvent.click(getByTestId('verify-cohort-receipt-btn'));

    expect(getByTestId('cohort-receipt-verdict').textContent).toContain('VALID');
  });

  it('US-05.2: supports cohort seed lengths 1..64 and score boundaries 0% (0/4 beds) to 100% (4/4 beds)', () => {
    const minCohort = 'A';
    const maxCohort = 'A'.repeat(64);

    const pMin = parseCohortSeed(minCohort);
    const pMax = parseCohortSeed(maxCohort);
    expect(pMin.valid).toBe(true);
    expect(pMax.valid).toBe(true);

    const rZero = generateCohortReceipt({
      cohort: minCohort,
      scorePct: 0,
      bedsStabilized: 0,
      violations: 4,
    });
    const rHundred = generateCohortReceipt({
      cohort: maxCohort,
      scorePct: 100,
      bedsStabilized: 4,
      violations: 0,
    });

    expect(verifyCohortReceipt(rZero).valid).toBe(true);
    expect(verifyCohortReceipt(rHundred).valid).toBe(true);
  });

  it('US-05.3: rejects XSS or >64-char cohort query params and rejects tampered receipts with CRC16_MISMATCH', () => {
    expect(parseCohortSeed('<script>alert(1)</script>').valid).toBe(false);
    expect(parseCohortSeed('A'.repeat(65)).valid).toBe(false);
    expect(parseCohortSeed('').valid).toBe(false);

    const validReceipt = generateCohortReceipt({
      cohort: 'NURS402-FALL26',
      scorePct: 92,
      bedsStabilized: 4,
      violations: 1,
    });
    // Tamper score from 92 to 100 while keeping original CRC16 suffix
    const tampered = validReceipt.replace('-92-', '-100-');
    const res = verifyCohortReceipt(tampered);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('CRC16_MISMATCH');

    // Canonical 4-segment receipt with invalid CRC16 suffix must return CRC16_MISMATCH
    const deadRes = verifyCohortReceipt('TW-NURS402-FALL26-100-DEAD');
    expect(deadRes.valid).toBe(false);
    expect(deadRes.reason).toBe('CRC16_MISMATCH');
  });

  it('US-05.4 & US-05.5: activates Stripe Checkout entitlement idempotently, supports offline sandbox activation, and handles ?checkout=cancelled cleanly', () => {
    const token = createSignedEntitlementToken('exam_pass');
    const act1 = activateEntitlement('exam_pass', token);
    const act2 = activateEntitlement('exam_pass', token);
    expect(act1.tier).toBe('exam_pass');
    expect(act2.tier).toBe('exam_pass');
    expect(readEntitlementFromStorage().tier).toBe('exam_pass');

    // Rejects missing token when allowSandboxMint is not true, and rejects mismatched tier/token
    window.localStorage.clear();
    expect(activateEntitlement('exam_pass').valid).toBe(false);
    expect(readEntitlementFromStorage().tier).toBe('free');
    expect(activateEntitlement('instructor_cohort', token).valid).toBe(false);
    expect(readEntitlementFromStorage().tier).toBe('free');

    // Rejects ?checkout=success&tier=exam_pass without token parameter in URL
    const { container: unauthContainer } = render(
      <App initialPath="/cohort?checkout=success&tier=exam_pass" preloadedDataset={DATASET} />
    );
    expect(unauthContainer.textContent).toContain('Checkout token invalid or missing');
    expect(readEntitlementFromStorage().tier).toBe('free');
    cleanup();

    window.localStorage.clear();
    const { getByTestId, container } = render(
      <App initialPath="/cohort?checkout=cancelled" preloadedDataset={DATASET} />
    );
    expect(container.textContent).toContain('Checkout cancelled');
    expect(readEntitlementFromStorage().tier).toBe('free');

    // Trigger offline/sandbox Pro Exam Pass activation from /cohort UI
    fireEvent.click(getByTestId('unlock-exam-pass-btn'));
    expect(readEntitlementFromStorage().tier).toBe('exam_pass');
    expect(getByTestId('active-entitlement-badge').textContent).toContain('exam_pass');
  });

  it('US-05.6: rejects forged localStorage entitlement tokens (invalid CRC32 signature) and resets to free tier', () => {
    const forgedToken = 'tw_pro_exam_pass_00000000';
    expect(verifyEntitlementToken(forgedToken).valid).toBe(false);

    window.localStorage.setItem(
      'teleward_entitlement_v1',
      JSON.stringify({ tier: 'exam_pass', token: forgedToken })
    );
    const loaded = readEntitlementFromStorage();
    expect(loaded.tier).toBe('free');
    expect(loaded.valid).toBe(false);
  });
});
