import { describe, it, expect, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPtbxlBinary } from '../src/data/ptbxlLoader.ts';
import {
  generateCohortReceipt,
  verifyCohortReceipt,
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

describe('Ticket 03: Backend-Synchronized Cohort Roster & Daily Challenge Leaderboard', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('US-03.3: renders live Classroom Cohort Roster table on /cohort, records student submissions, and verifies CRC16 receipts', async () => {
    const { getByTestId } = render(
      h(App, { initialPath: '/cohort?cohort=SPRING-2026-ICU', preloadedDataset: DATASET })
    );

    const rosterTable = await waitFor(() => getByTestId('cohort-roster-table'));
    expect(rosterTable).toBeTruthy();
    expect(rosterTable.textContent).toContain('R. Patel, BSN RN');

    const aliasInput = getByTestId('cohort-student-alias-input') as HTMLInputElement;
    fireEvent.input(aliasInput, { target: { value: 'S. Park, BSN' } });
    fireEvent.click(getByTestId('submit-cohort-run-btn'));

    await waitFor(() => {
      expect(getByTestId('cohort-roster-table').textContent).toContain('S. Park, BSN');
    });

    const receipt = generateCohortReceipt({
      cohort: 'SPRING-2026-ICU',
      scorePct: 92,
      bedsStabilized: 4,
      violations: 1,
    });
    expect(verifyCohortReceipt(receipt).valid).toBe(true);

    const verifierInput = getByTestId('cohort-receipt-input') as HTMLInputElement;
    fireEvent.input(verifierInput, { target: { value: receipt } });
    fireEvent.click(getByTestId('verify-cohort-receipt-btn'));
    expect(getByTestId('cohort-receipt-verdict').textContent).toContain('VALID RECEIPT');
  });

  it('US-03.3: renders Daily Challenge Leaderboard on /daily and records daily challenge completion receipt', async () => {
    const { getByTestId, container } = render(
      h(App, { initialPath: '/daily', preloadedDataset: DATASET, initialSeed: 101 })
    );

    const lbTable = await waitFor(() => getByTestId('daily-leaderboard-table'));
    expect(lbTable).toBeTruthy();
    expect(lbTable.textContent).toContain('Dr. M. Al-Mansoor (ICU)');

    fireEvent.click(getByTestId('finish-daily-shift-btn'));
    expect(container.textContent).toContain('TW-DAILY-');
  });
});
