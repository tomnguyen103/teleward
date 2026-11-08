import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPtbxlBinary } from '../src/data/ptbxlLoader.ts';
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

describe('Ticket 02: Obsidian ICU Telemetry Cockpit, Unified 64px Header & 2-Bay Crash Cart', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('US-02.1: defaults root theme to dark (Obsidian ICU Cockpit) and eliminates all #4338CA / #818CF8 indigo tokens from CSS and UI sources', () => {
    render(<App initialPath="/shift" preloadedDataset={DATASET} initialSeed={42} />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    const cssSource = readFileSync(resolve(WORKSPACE_ROOT, 'src/index.css'), 'utf-8');
    expect(cssSource).toContain('#070A0E');
    expect(cssSource).toContain('#0C1117');
    expect(cssSource).toContain('#04070A');
    expect(cssSource).toContain('#10B981');
    expect(cssSource).toContain('#00E676');
    expect(cssSource).toContain('#FF5252');
    expect(cssSource).toContain('#00E5FF');
    expect(cssSource).toContain('#FFD740');
    expect(cssSource.toUpperCase()).not.toContain('#4338CA');
    expect(cssSource.toUpperCase()).not.toContain('#818CF8');

    const canvasSource = readFileSync(
      resolve(WORKSPACE_ROOT, 'src/ui/canvas/TelemetryCanvas.ts'),
      'utf-8'
    );
    expect(canvasSource.toUpperCase()).not.toContain('#4338CA');
    expect(canvasSource.toUpperCase()).not.toContain('#818CF8');
  });

  it('US-02.2: embeds audio-arm-banner and 120s alarm silence countdown inside a single unified 64px header bar', () => {
    const { getByTestId, container } = render(
      <App initialPath="/shift?cohort=NURS402-FALL26" preloadedDataset={DATASET} initialSeed={42} />
    );

    const headerEl = container.querySelector('header');
    expect(headerEl).toBeTruthy();
    const audioBanner = getByTestId('audio-arm-banner');
    expect(headerEl?.contains(audioBanner)).toBe(true);
    expect(audioBanner.textContent).toContain('IEC 60601-1-8');
    expect(audioBanner.textContent).toContain('NURS402-FALL26');

    const silenceBtn = getByTestId('alarm-silence-120s-btn');
    expect(silenceBtn).toBeTruthy();
    expect(silenceBtn.textContent).toContain('120s');

    // Arm audio first so silence 120s mutes and then auto-unmutes when the 120s timer expires
    const prevAudioCtx = window.AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = class MockAudioContext {
      public state = 'running';
      public currentTime = 0;
      public destination = {};
      public resume() {
        return Promise.resolve();
      }
      public createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime: () => {} },
          connect: () => {},
          start: () => {},
          stop: () => {},
          disconnect: () => {},
        };
      }
      public createGain() {
        return {
          gain: {
            setValueAtTime: () => {},
            linearRampToValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
          connect: () => {},
          disconnect: () => {},
        };
      }
    };
    vi.useFakeTimers();
    try {
      const armBtn = getByTestId('arm-audio-btn');
      fireEvent.click(armBtn);
      expect(armBtn.textContent?.toUpperCase()).toContain('ARMED');

      fireEvent.click(silenceBtn);
      expect(silenceBtn.textContent).toContain('Audio Paused');
      expect(armBtn.textContent?.toUpperCase()).toContain('MUTED');

      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(silenceBtn.textContent).toContain('120s');
      expect(armBtn.textContent?.toUpperCase()).toContain('ARMED');
    } finally {
      vi.useRealTimers();
      (window as unknown as { AudioContext: unknown }).AudioContext = prevAudioCtx;
    }
  });

  it('US-02.3 & US-02.4: renders 4-channel trace labels (II 1.0mV, ART mmHg, PLETH, CO2 mmHg), RR vital readout, and 2-Bay Crash Cart with hotkeys 1-8', () => {
    const { getByTestId, container } = render(
      <App initialPath="/shift" preloadedDataset={DATASET} initialSeed={42} />
    );

    const text = container.textContent ?? '';
    expect(text).toContain('II 1.0mV');
    expect(text).toContain('ART mmHg');
    expect(text).toContain('PLETH');
    expect(text).toContain('CO2 mmHg');
    expect(text).toContain('RR');
    expect(text).toContain('Electrical Therapy Bay');
    expect(text).toContain('IV Bolus Rack');

    // Select Bed 02 and trigger hotkey for its rescuing intervention
    fireEvent.click(getByTestId('bed-card-1'));
    expect(getByTestId('acting-as-bed-guard').textContent).toContain('Bed 02');

    const bed1Rhythm = getByTestId('bed-rhythm-1').textContent?.trim() ?? '';
    const hotkeyByRhythm: Record<string, string> = {
      SVT: '4', // adenosine_6mg
      AFIB: '1', // sync_cardioversion
      AFLT: '1', // sync_cardioversion
      VT_MONO: '1', // sync_cardioversion
      VFIB: '2', // defibrillation
      AVB3: '3', // transcutaneous_pacing
      STEMI_ANT: '5', // amiodarone_300mg
      ASYSTOLE: '6', // epinephrine_1mg
      PEA: '6', // epinephrine_1mg
      SB: '7', // atropine_1mg
      TORSADES: '8', // magnesium_2g
      NSR: '5',
    };
    const keyToPress = hotkeyByRhythm[bed1Rhythm] ?? '2';
    fireEvent.keyDown(window, { key: keyToPress });
    expect(getByTestId('bed-rhythm-1').textContent).toContain('NSR');
  });

  it('US-03.1 & US-03.2: supports direct canvas pointer hit-testing on T1/T2/V1/V2 hairlines and 25/50 mm/s speed & 5/10/20 mm/mV gain toggles', () => {
    const { getByTestId, container } = render(
      <App initialPath="/caliper/ptbxl-001" preloadedDataset={DATASET} />
    );

    // Verify paper speed (25 / 50 mm/s) and gain (5 / 10 / 20 mm/mV) toggles preserve physiological ms/mV readings
    const speed50Btn = getByTestId('caliper-speed-50');
    const speed25Btn = getByTestId('caliper-speed-25');
    const gain20Btn = getByTestId('caliper-gain-20');
    const gain5Btn = getByTestId('caliper-gain-5');
    const gain10Btn = getByTestId('caliper-gain-10');

    expect(getByTestId('caliper-t1-ms').textContent).toBe('240 ms');
    expect(getByTestId('caliper-t2-ms').textContent).toBe('1040 ms');

    fireEvent.click(speed50Btn);
    expect(container.textContent).toContain('50 mm/s');
    expect(getByTestId('caliper-t1-ms').textContent).toBe('240 ms');
    expect(getByTestId('caliper-t2-ms').textContent).toBe('1040 ms');

    fireEvent.click(gain20Btn);
    expect(container.textContent).toContain('20 mm/mV');
    expect(getByTestId('caliper-v2-mv').textContent).toBe('0.25 mV');

    fireEvent.click(speed25Btn);
    fireEvent.click(gain5Btn);
    expect(container.textContent).toContain('5 mm/mV');
    fireEvent.click(gain10Btn);

    // Direct canvas pointer hit-testing: T1 is at 240ms -> x = (240/10000)*960 = ~23px.
    // Without clicking caliper-handle-btn-t1 first (activeHandle starts as 't2'), pressing near x=23 grabs T1 directly!
    const canvasEl = getByTestId('caliper-12lead-canvas');
    fireEvent.pointerDown(canvasEl, { clientX: 23, clientY: 120 });
    fireEvent.pointerMove(canvasEl, { clientX: 192, clientY: 120 });
    fireEvent.pointerUp(canvasEl);

    expect(getByTestId('caliper-t1-ms').textContent).toBe('2000 ms');
    expect(getByTestId('caliper-t2-ms').textContent).toBe('1040 ms');

    // Direct canvas pointer hit-testing on V1 (v1Mv = 0.0 -> y = 367.5px on 420px canvas)
    fireEvent.pointerDown(canvasEl, { clientX: 500, clientY: 368 });
    fireEvent.pointerMove(canvasEl, { clientX: 500, clientY: 332 });
    fireEvent.pointerUp(canvasEl);
    expect(getByTestId('caliper-v1-mv').textContent).not.toBe('0 mV');

    // At 50 mm/s (5000 ms visible across 960px canvas), T2 at 1040ms is at x = (1040/5000)*960 = 199.68px.
    // Dragging T2 to x = 480px (midpoint of 960px canvas) must map to 2500 ms (not 5000 ms).
    fireEvent.click(speed50Btn);
    fireEvent.pointerDown(canvasEl, { clientX: 200, clientY: 120 });
    fireEvent.pointerMove(canvasEl, { clientX: 480, clientY: 120 });
    fireEvent.pointerUp(canvasEl);
    expect(getByTestId('caliper-t2-ms').textContent).toBe('2500 ms');
  });

  it('US-04.1, US-04.2 & US-04.3: normalizes lowercase cohort seeds, keeps Bazett QTc idempotent across repeated caliper autofills, preserves 12-rhythm counts under filter, and enforces single H1 and standalone layout on /daily', async () => {
    const { parseCohortSeed } = await import('../src/billing/cohortAndEntitlement.ts');
    const lowerSeed = parseCohortSeed('nurs402-fall26');
    const upperSeed = parseCohortSeed('NURS402-FALL26');
    expect(lowerSeed.valid).toBe(true);
    expect(lowerSeed.cohort).toBe('NURS402-FALL26');
    expect(lowerSeed.numericSeed).toBe(upperSeed.numericSeed);

    const { getByTestId, container } = render(
      <App initialPath="/caliper/ptbxl-001" preloadedDataset={DATASET} />
    );
    const autofillBtn = getByTestId('autofill-caliper-fiducials-btn');
    const setQtBtn = getByTestId('set-caliper-qt-btn');
    const setStBtn = getByTestId('set-caliper-st-btn');
    const qtcField = container.querySelector('#input-qtc-ms') as HTMLInputElement;
    const stField = container.querySelector('#input-st-mv') as HTMLInputElement;
    const calCanvas = getByTestId('caliper-12lead-canvas') as HTMLCanvasElement;
    fireEvent.click(setStBtn);
    expect(stField.value).toBe('0.25');
    fireEvent.click(autofillBtn);
    expect(qtcField.value).toBe('894');
    fireEvent.click(autofillBtn);
    expect(qtcField.value).toBe('894');

    // Measure QT = 380 ms (T1 = 240 ms, T2 = 620 ms -> x = 59.52px on 960px 10000ms canvas), click Set QT, then restore T2 = 1040 ms (RR = 800 ms -> x = 99.84px)
    fireEvent.click(calCanvas, { clientX: 59.52, clientY: 120 });
    expect(getByTestId('caliper-t2-ms').textContent).toBe('620 ms');
    fireEvent.click(setQtBtn);
    fireEvent.click(calCanvas, { clientX: 99.84, clientY: 120 });
    expect(getByTestId('caliper-t2-ms').textContent).toBe('1040 ms');
    fireEvent.click(autofillBtn);
    expect(qtcField.value).toBe('425');
    fireEvent.click(autofillBtn);
    expect(qtcField.value).toBe('425');

    const sidebar = container.querySelector('#tw-scope-sidebar')!;
    const nsrBtn = Array.from(sidebar.querySelectorAll('button')).find(
      (b) => !b.textContent?.startsWith('Bed ') && b.textContent?.includes('NSR')
    )!;
    fireEvent.click(nsrBtn);
    const svtBtn = Array.from(sidebar.querySelectorAll('button')).find(
      (b) => !b.textContent?.startsWith('Bed ') && b.textContent?.includes('SVT')
    )!;
    expect(svtBtn.textContent).toContain('2/10');

    const inspector = getByTestId('causal-timeline-inspector');
    expect(inspector.getAttribute('aria-hidden')).toBe('true');
    expect(inspector.classList.contains('hidden')).toBe(true);
    fireEvent.click(getByTestId('toggle-causal-drawer-btn'));
    expect(inspector.getAttribute('aria-hidden')).toBe('false');
    expect(inspector.classList.contains('flex')).toBe(true);
    fireEvent.click(getByTestId('toggle-causal-drawer-btn'));
    expect(inspector.getAttribute('aria-hidden')).toBe('true');
    expect(inspector.classList.contains('hidden')).toBe(true);

    cleanup();

    const { container: dailyContainer, getByTestId: getDailyTestId } = render(
      <App initialPath="/daily" preloadedDataset={DATASET} initialSeed={101} />
    );
    expect(dailyContainer.querySelectorAll('h1').length).toBe(1);
    expect(dailyContainer.querySelector('h1')?.textContent).toBe('Daily Shift Seed');
    const lbSection = getDailyTestId('daily-leaderboard-table').closest('section')!;
    expect(lbSection.classList.contains('flex')).toBe(true);
    // F-18 & T-07: ShiftStationView (bed-card-0) is not mounted inline on /daily until Run Daily Shift is clicked
    expect(dailyContainer.querySelector('[data-testid="bed-card-0"]')).toBeNull();
    fireEvent.click(getDailyTestId('launch-daily-shift-btn'));
    expect(dailyContainer.querySelector('[data-testid="bed-card-0"]')).not.toBeNull();

    cleanup();

    const { generateCohortReceipt } = await import('../src/billing/cohortAndEntitlement.ts');
    const mismatchedReceipt = generateCohortReceipt({
      cohort: 'EMS201',
      scorePct: 90,
      bedsStabilized: 4,
      violations: 0,
    });
    const { getByTestId: getCohortTestId, container: cohortContainer } = render(
      <App initialPath="/cohort" preloadedDataset={DATASET} />
    );
    expect(cohortContainer.querySelectorAll('h1').length).toBe(1);
    const verifierTab = Array.from(cohortContainer.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes('Receipt Verifier')
    )!;
    fireEvent.click(verifierTab);
    expect(verifierTab.getAttribute('aria-selected')).toBe('true');
    expect(verifierTab.classList.contains('tw-seg-btn-active')).toBe(true);
    const receiptInput = getCohortTestId('cohort-receipt-input') as HTMLInputElement;
    fireEvent.input(receiptInput, { target: { value: mismatchedReceipt } });
    fireEvent.click(getCohortTestId('verify-cohort-receipt-btn'));
    expect(getCohortTestId('cohort-receipt-verdict').textContent).toContain(
      'INVALID RECEIPT (INVALID_COHORT)'
    );
  });

  it('v2.0 Audit (F-15..F-22): enforces route-scoped left rail, 4-field bed cards, 3-word Crash Cart buttons, on-demand Code Cart drawer, clean-path router without URIError, VTM/STM compact rail badges, and 40px touch targets', async () => {
    const { parseTelewardRoute, buildCohortSubPath } = await import('../src/ui/router.ts');

    // 1. Clean-path router parsing & generation (zero ?tab= or ?cohort= query strings, safe against malformed URI)
    expect(buildCohortSubPath('roster', 'NURS402-FALL26')).toBe('/cohort/roster/NURS402-FALL26');
    expect(buildCohortSubPath('assign', 'NURS402-FALL26')).toBe('/cohort/assign');
    expect(buildCohortSubPath('billing')).toBe('/cohort/billing');
    expect(parseTelewardRoute('/cohort/roster/NURS402-FALL26')).toMatchObject({
      area: 'cohort',
      cohortSubRoute: 'roster',
      cohortSeed: 'NURS402-FALL26',
    });
    expect(parseTelewardRoute('/shift/cohort/NURS402-FALL26')).toMatchObject({
      area: 'shift',
      cohortSeed: 'NURS402-FALL26',
    });
    expect(() => parseTelewardRoute('/caliper/%E0%A4%A')).not.toThrow();
    expect(() => parseTelewardRoute('/cohort/roster/%E0%A4%A')).not.toThrow();

    // 2. Shift view: route-scoped left rail (Ward Beds only), 4-field bed card ceiling, 3-word button ceiling, on-demand Code Cart drawer, and 40px touch targets
    const { getByTestId, container } = render(
      <App initialPath="/shift" preloadedDataset={DATASET} initialSeed={42} />
    );

    const shiftRail = container.querySelector('#tw-scope-sidebar')!;
    expect(shiftRail.textContent).toContain('Ward Beds');
    expect(shiftRail.textContent).not.toContain('Rhythm Class');

    const bedCard0 = getByTestId('bed-card-0');
    const dlItems = bedCard0.querySelectorAll('dl > div');
    expect(dlItems.length).toBeLessThanOrEqual(2); // 2 <dl> rows + Bed ID + Rhythm/Status = 4 fields max

    const codeCartDrawer = getByTestId('code-cart-drawer');
    expect(codeCartDrawer.getAttribute('aria-hidden')).toBe('true');
    expect(codeCartDrawer.classList.contains('hidden')).toBe(true);

    fireEvent.click(getByTestId('open-code-cart-btn'));
    expect(codeCartDrawer.getAttribute('aria-hidden')).toBe('false');
    expect(codeCartDrawer.classList.contains('block')).toBe(true);

    // Every Crash Cart button must obey the <= 3 word ASD-STE100 ceiling
    const crashButtons = Array.from(codeCartDrawer.querySelectorAll('[data-testid^="crash-cart-btn-"]'));
    expect(crashButtons.length).toBe(8);
    for (const btn of crashButtons) {
      const words = (btn.textContent ?? '').trim().split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThanOrEqual(3);
    }

    // 40px (min-h-10) touch targets on topbar pills
    expect(getByTestId('arm-audio-btn').className).toContain('min-h-10');
    expect(getByTestId('alarm-silence-120s-btn').className).toContain('min-h-10');

    cleanup();

    // 3. Caliper view: route-scoped left rail (Rhythm Class only) and clean VTM/STM collapsed rail badges (never VT_)
    window.localStorage.setItem('teleward_sidebar_collapsed_v1', 'false');
    const { getByTestId: getCalTestId, container: calContainer } = render(
      <App initialPath="/caliper/ptbxl-001" preloadedDataset={DATASET} />
    );
    const calRail = calContainer.querySelector('#tw-scope-sidebar')!;
    expect(calRail.textContent).toContain('Rhythm Class');
    expect(calRail.textContent).not.toContain('Ward Beds');

    fireEvent.click(getCalTestId('sidebar-collapse-toggle'));
    expect(calRail.textContent).toContain('VTM');
    expect(calRail.textContent).toContain('STM');
    expect(calRail.textContent).not.toContain('VT_');
  });
});
