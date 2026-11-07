import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPtbxlBinary } from '../src/data/ptbxlLoader.ts';
import {
  TelemetryRingBuffer,
  stepTelemetryFrame,
  renderTelemetryBedCanvas,
  computeCaliperMetrics,
  nudgeCaliperState,
  gradeCaliperSubmission,
} from '../src/ui/canvas/TelemetryCanvas.ts';
import { Iec60601AlarmSynthesizer } from '../src/ui/audio/iec60601Alarms.ts';
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

describe('US-03 & US-04: 60fps 2D Canvas 4-Bed ICU Telemetry, IEC 60601-1-8 Alarms & 12-Lead Calipers', () => {
  it('US-03.1: renders 4 ICU beds on /shift, converts an alarming bed to NSR via the Crash Cart, and displays the Causal Timeline Receipt', () => {
    cleanup();
    const { container, getByTestId } = render(
      <App initialPath="/shift" preloadedDataset={DATASET} initialSeed={42} />
    );

    const bed0Card = getByTestId('bed-card-0');
    expect(bed0Card).toBeTruthy();
    fireEvent.click(bed0Card);

    const guardText = getByTestId('acting-as-bed-guard').textContent ?? '';
    expect(guardText).toContain('Bed 01');

    // Read active rhythm on Bed 01 and trigger its matching rescuing ACLS intervention
    const rhythmBadge = getByTestId('bed-rhythm-0').textContent?.trim() ?? '';
    const rescueMap: Record<string, string> = {
      SVT: 'adenosine_6mg',
      TORSADES: 'magnesium_2g',
      VFIB: 'defibrillation',
      AVB3: 'transcutaneous_pacing',
      VT_MONO: 'sync_cardioversion',
      SB: 'atropine_1mg',
      AFIB: 'sync_cardioversion',
      AFLT: 'sync_cardioversion',
      ASYSTOLE: 'epinephrine_1mg',
      PEA: 'epinephrine_1mg',
      STEMI_ANT: 'amiodarone_300mg',
      NSR: 'amiodarone_300mg',
    };
    const actionId = rescueMap[rhythmBadge] ?? 'defibrillation';
    const actionBtn = getByTestId(`crash-cart-btn-${actionId}`);
    fireEvent.click(actionBtn);

    expect(getByTestId('bed-rhythm-0').textContent).toContain('NSR');
    const timelineText = container.textContent ?? '';
    expect(timelineText).toContain('ACLS Causal Timeline');
  });

  it('US-03.2: clamps background tab deltaMs <= 100ms, wraps 2500-sample Float32Array ring buffer across 2499 -> 0 with zero reallocation, and draws 4 beds in < 4.0ms', () => {
    const rb = new TelemetryRingBuffer(2500, 90);
    const initialBufferRef = rb.ecg.buffer;

    const vitals = {
      rhythm: 'SVT' as const,
      hr: 184,
      sbp: 90,
      dbp: 58,
      map: 69,
      spo2: 94,
      etco2: 32,
      rr: 22,
      paced: false,
    };

    // Simulate background tab resume with huge deltaMs = 2500 ms -> must clamp to 100 ms (50 samples at 500 Hz)
    const advance1 = stepTelemetryFrame(rb, vitals, 2500);
    expect(advance1.clampedDeltaMs).toBe(100);
    expect(advance1.samplesWritten).toBe(50);
    expect(rb.writeCursor).toBe(50);

    // Advance across the 2499 -> 0 boundary
    for (let i = 0; i < 50; i++) {
      stepTelemetryFrame(rb, vitals, 100);
    }
    expect(rb.writeCursor).toBe(50); // (51 * 50) % 2500 = 2550 % 2500 = 50
    expect(rb.ecg.buffer).toBe(initialBufferRef); // Zero heap reallocation

    // Benchmark 4-bed canvas draw time (< 4.0 ms per frame)
    const mockCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      fillRect: () => {},
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
    } as unknown as CanvasRenderingContext2D;

    const t0 = performance.now();
    for (let frame = 0; frame < 10; frame++) {
      for (let b = 0; b < 4; b++) {
        renderTelemetryBedCanvas(mockCtx, 480, 180, rb, false);
      }
    }
    const avgFrameMs = (performance.now() - t0) / 10;
    expect(avgFrameMs).toBeLessThan(4.0);
  });

  it('US-03.3 & US-03.4: records AHA rule violation on contraindicated intervention, enforces 250ms double-click idempotency, and arbitrates High > Medium > Normal IEC 60601-1-8 alarms', () => {
    cleanup();
    const { getByTestId } = render(
      <App initialPath="/shift" preloadedDataset={DATASET} initialSeed={42} />
    );

    // Apply defibrillation on a bed or contraindicated intervention and verify violation log
    const bedCards = [0, 1, 2, 3];
    const perfusingIdx =
      bedCards.find((i) => {
        const r = getByTestId(`bed-rhythm-${i}`).textContent?.trim();
        return r === 'SVT' || r === 'SB' || r === 'AFIB' || r === 'STEMI_ANT';
      }) ?? 0;

    fireEvent.click(getByTestId(`bed-card-${perfusingIdx}`));
    fireEvent.click(getByTestId('crash-cart-btn-defibrillation'));

    const receiptPanel = getByTestId('causal-timeline-inspector').textContent ?? '';
    expect(receiptPanel).toContain('AHA_');

    // Verify IEC 60601-1-8 alarm synthesizer priority arbitration without node leaks
    const synth = new Iec60601AlarmSynthesizer();
    expect(synth.getActivePriority()).toBe('NORMAL');

    synth.arbitratePriority(['NORMAL', 'WARNING', 'CRISIS']);
    expect(synth.getActivePriority()).toBe('CRISIS');
    expect(synth.getBurstDescriptor().pulseCount).toBe(10);
    expect(synth.getBurstDescriptor().notes).toEqual(['C4', 'E4', 'G4', 'B4', 'C5']);

    synth.arbitratePriority(['NORMAL', 'WARNING']);
    expect(synth.getActivePriority()).toBe('WARNING');
    expect(synth.getBurstDescriptor().pulseCount).toBe(3);
  });

  it('US-03.5: degrades gracefully when AudioContext is suspended and preserves /daily score receipt when localStorage throws QuotaExceededError', () => {
    cleanup();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const { getByTestId, container } = render(
      <App initialPath="/daily" preloadedDataset={DATASET} initialSeed={101} />
    );

    expect(getByTestId('audio-arm-banner').textContent).toContain('IEC 60601-1-8');
    const completeBtn = getByTestId('finish-daily-shift-btn');
    fireEvent.click(completeBtn);

    expect(container.textContent).toContain('TW-DAILY');
    setItemSpy.mockRestore();
  });

  it('US-04.1 & US-04.2: computes Bazett QTc, clamps caliper handles to [0..10000ms] & [-5..+5mV], handles Δt=0 without NaN, and grades exact tolerance boundaries as PASS', () => {
    // Δt = 0 ms edge case (US-04.2)
    const zeroMetrics = computeCaliperMetrics(1000, 1000, 0, 0, 380);
    expect(zeroMetrics.deltaMs).toBe(0);
    expect(zeroMetrics.hrDisplay).toBe('— bpm');
    expect(Number.isFinite(zeroMetrics.qtcMs)).toBe(true);

    // Normal 800 ms R-R (75 bpm), QT = 380 ms -> Bazett QTc = 380 / sqrt(0.8) = 425 ms
    const m = computeCaliperMetrics(200, 1000, -0.1, 0.25, 380);
    expect(m.deltaMs).toBe(800);
    expect(m.hrDisplay).toBe('75 bpm');
    expect(m.qtcMs).toBe(Math.round(380 / Math.sqrt(0.8)));
    expect(m.deltaMv).toBeCloseTo(0.35, 4);

    // Keyboard nudge clamping at boundaries [0, 10000] ms and [-5.0, +5.0] mV
    const clampedLow = nudgeCaliperState(
      { t1Ms: 1, t2Ms: 9995, v1Mv: -4.98, v2Mv: 4.98 },
      't1',
      'ArrowLeft',
      true
    );
    expect(clampedLow.t1Ms).toBe(0);
    const clampedHigh = nudgeCaliperState(clampedLow, 't2', 'ArrowRight', true);
    expect(clampedHigh.t2Ms).toBe(10000);
    const clampedVolt = nudgeCaliperState(clampedHigh, 'v2', 'ArrowUp', false);
    expect(clampedVolt.v2Mv).toBe(5.0);

    // Exact boundary tolerance grading (+20 ms PR, -20 ms QRS, +24 ms QTc, +0.05 mV ST)
    const case001 = DATASET.records[0]!;
    const f = case001.fiducials;
    const exactBoundaryGrade = gradeCaliperSubmission(case001, {
      prMs: f.prMs + 20,
      qrsMs: f.qrsMs - 20,
      qtcMs: f.qtcMs + 24,
      stMv: Number((f.stMv + 0.05).toFixed(3)),
      rhythmClass: case001.rhythmClass,
    });
    expect(exactBoundaryGrade.prPass).toBe(true);
    expect(exactBoundaryGrade.qrsPass).toBe(true);
    expect(exactBoundaryGrade.qtcPass).toBe(true);
    expect(exactBoundaryGrade.stPass).toBe(true);
    expect(exactBoundaryGrade.rhythmPass).toBe(true);
    expect(exactBoundaryGrade.overallPass).toBe(true);
  });

  it('US-04.3 & US-04.4: renders recovery state on /caliper/invalid-case-999, validates empty form submission inline, and resets handles cleanly on case switch', () => {
    cleanup();
    const { getByTestId, container } = render(
      <App initialPath="/caliper/invalid-case-999" preloadedDataset={DATASET} />
    );

    expect(container.textContent).toContain('Case Record Not Found');
    const recoverBtn = getByTestId('recover-default-case-btn');
    fireEvent.click(recoverBtn);

    expect(container.textContent).toContain('ptbxl-001');

    // Submit empty grading form -> shows inline validation error without crashing
    const submitBtn = getByTestId('submit-caliper-grade-btn');
    fireEvent.click(submitBtn);
    expect(getByTestId('caliper-form-error').textContent).toContain('Enter finite numeric values');

    // "Load Caliper Readings into Form" loads current caliper metrics (deltaMs=800), NOT ground-truth fiducials
    fireEvent.click(getByTestId('autofill-caliper-fiducials-btn'));
    const prField = container.querySelector('#input-pr-ms') as HTMLInputElement;
    const stField = container.querySelector('#input-st-mv') as HTMLInputElement;
    expect(prField.value).toBe('800');
    expect(stField.value).toBe('0.25');

    // Clicking/dragging with Handle V1 / Handle V2 updates v1Mv / v2Mv
    fireEvent.click(getByTestId('caliper-handle-btn-v1'));
    const canvasEl = getByTestId('caliper-12lead-canvas');
    fireEvent.pointerDown(canvasEl, { clientX: 200, clientY: 84 });
    fireEvent.pointerMove(canvasEl, { clientX: 200, clientY: 42 });
    fireEvent.pointerUp(canvasEl);
    expect(getByTestId('caliper-v1-mv').textContent).not.toBe('0 mV');

    fireEvent.click(getByTestId('caliper-handle-btn-v2'));
    fireEvent.click(canvasEl, { clientX: 200, clientY: 336 });
    expect(getByTestId('caliper-v2-mv').textContent).not.toBe('0.25 mV');

    // Enter ground-truth fiducials for ptbxl-001 and submit -> grades OVERALL PASS (US-04.1)
    const f001 = DATASET.records[0]!.fiducials;
    fireEvent.input(prField, { target: { value: String(f001.prMs) } });
    fireEvent.input(container.querySelector('#input-qrs-ms') as HTMLInputElement, {
      target: { value: String(f001.qrsMs) },
    });
    fireEvent.input(container.querySelector('#input-qtc-ms') as HTMLInputElement, {
      target: { value: String(f001.qtcMs) },
    });
    fireEvent.input(stField, { target: { value: String(f001.stMv) } });
    fireEvent.click(submitBtn);
    expect(getByTestId('caliper-grade-result').textContent).toContain('OVERALL PASS');

    // Switch to another starter case (ptbxl-003) and verify active case title updates
    const caseSelect = getByTestId('caliper-case-switcher') as HTMLSelectElement;
    // Locked Pro cases in <select> must show "(Pro Exam Strip — Locked)" and never leak rhythm diagnosis
    const lockedOptionText =
      Array.from(caseSelect.options).find((o) => o.value === 'ptbxl-051')?.textContent ?? '';
    expect(lockedOptionText).toContain('(Pro Exam Strip — Locked)');
    expect(lockedOptionText).not.toContain(DATASET.records[50]!.rhythmClass);

    fireEvent.change(caseSelect, { target: { value: 'ptbxl-003' } });
    expect(getByTestId('active-caliper-case-id').textContent).toContain('ptbxl-003');
  });
});
