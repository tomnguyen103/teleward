import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
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
    fireEvent.click(silenceBtn);
    expect(silenceBtn.textContent).toContain('SILENCED');
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
    expect(text).toContain('ISO-26825 IV Pharmacology Bolus Rack');

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
  });
});
