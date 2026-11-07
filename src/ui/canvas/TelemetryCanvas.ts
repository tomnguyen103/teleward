import { synthesizeRealtimeSample } from '../../engine/physiology.ts';
import {
  LEAD_NAMES,
  type PtbxlCaseRecord,
  type RhythmClass,
  type VitalState,
} from '../../types/teleward.ts';
import type { CaseWaveforms12Lead } from '../../data/ptbxlLoader.ts';

/**
 * Zero-allocation Float32Array circular buffer for 500 Hz 4-trace ICU bed telemetry.
 */
export class TelemetryRingBuffer {
  public readonly capacity: number;
  public readonly eraseGapSamples: number;
  public readonly ecg: Float32Array;
  public readonly abp: Float32Array;
  public readonly spo2: Float32Array;
  public readonly etco2: Float32Array;
  public writeCursor = 0;
  public sampleTimeSec = 0;

  constructor(capacity = 2500, eraseGapSamples = 90) {
    this.capacity = capacity;
    this.eraseGapSamples = eraseGapSamples;
    this.ecg = new Float32Array(capacity);
    this.abp = new Float32Array(capacity);
    this.spo2 = new Float32Array(capacity);
    this.etco2 = new Float32Array(capacity);
  }

  public prefill(vitals: VitalState, samplesToFill = 1200): void {
    const count = Math.min(this.capacity, samplesToFill);
    for (let i = 0; i < count; i++) {
      this.sampleTimeSec += 0.002;
      const s = synthesizeRealtimeSample(vitals, this.sampleTimeSec);
      this.ecg[this.writeCursor] = s.ecgMv;
      this.abp[this.writeCursor] = s.abpMmHg;
      this.spo2[this.writeCursor] = s.spo2Wave;
      this.etco2[this.writeCursor] = s.etco2MmHg;
      this.writeCursor = (this.writeCursor + 1) % this.capacity;
    }
  }
}

export function stepTelemetryFrame(
  ring: TelemetryRingBuffer,
  vitals: VitalState,
  rawDeltaMs: number
): { clampedDeltaMs: number; samplesWritten: number } {
  const clampedDeltaMs = Math.max(0, Math.min(100, rawDeltaMs));
  const samplesWritten = Math.max(1, Math.round((clampedDeltaMs / 1000) * 500));

  for (let i = 0; i < samplesWritten; i++) {
    ring.sampleTimeSec += 0.002;
    const s = synthesizeRealtimeSample(vitals, ring.sampleTimeSec);
    ring.ecg[ring.writeCursor] = s.ecgMv;
    ring.abp[ring.writeCursor] = s.abpMmHg;
    ring.spo2[ring.writeCursor] = s.spo2Wave;
    ring.etco2[ring.writeCursor] = s.etco2MmHg;
    ring.writeCursor = (ring.writeCursor + 1) % ring.capacity;
  }

  return { clampedDeltaMs, samplesWritten };
}

function isInEraseBar(sampleIdx: number, writeCursor: number, eraseGap: number, capacity: number): boolean {
  const distAhead = (sampleIdx - writeCursor + capacity) % capacity;
  return distAhead > 0 && distAhead < eraseGap;
}

export function getSafe2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return null;
  }
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

export function renderTelemetryBedCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  ring: TelemetryRingBuffer,
  selected: boolean
): void {
  ctx.fillStyle = '#0B0F17';
  ctx.fillRect(0, 0, width, height);

  // Subtle millimeter calibration grid
  ctx.strokeStyle = selected ? 'rgba(129, 140, 248, 0.14)' : 'rgba(148, 163, 184, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x += 24) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y < height; y += 24) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  const stride = Math.max(1, Math.floor(ring.capacity / Math.max(64, width)));
  const traces: Array<{
    arr: Float32Array;
    color: string;
    centerY: number;
    scaleY: number;
    offsetVal: number;
  }> = [
    { arr: ring.ecg, color: '#22C55E', centerY: height * 0.24, scaleY: -22, offsetVal: 0 },
    { arr: ring.abp, color: '#F87171', centerY: height * 0.56, scaleY: -0.25, offsetVal: 70 },
    { arr: ring.spo2, color: '#38BDF8', centerY: height * 0.77, scaleY: -18, offsetVal: 0.3 },
    { arr: ring.etco2, color: '#FBBF24', centerY: height * 0.93, scaleY: -0.45, offsetVal: 20 },
  ];

  for (let t = 0; t < traces.length; t++) {
    const tr = traces[t]!;
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = t === 0 ? 1.75 : 1.3;
    ctx.beginPath();
    let penDown = false;

    for (let s = 0; s < ring.capacity; s += stride) {
      if (isInEraseBar(s, ring.writeCursor, ring.eraseGapSamples, ring.capacity)) {
        penDown = false;
        continue;
      }
      const x = (s / ring.capacity) * width;
      const val = tr.arr[s]!;
      const y = tr.centerY + (val - tr.offsetVal) * tr.scaleY;
      if (!penDown) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}

export interface CaliperState {
  t1Ms: number;
  t2Ms: number;
  v1Mv: number;
  v2Mv: number;
}

export interface CaliperComputedMetrics {
  deltaMs: number;
  hrBpm: number | null;
  hrDisplay: string;
  qtcMs: number;
  deltaMv: number;
  marchingSpikesMs: number[];
}

export function computeCaliperMetrics(
  t1Ms: number,
  t2Ms: number,
  v1Mv: number,
  v2Mv: number,
  qtInputMs = 380
): CaliperComputedMetrics {
  const cT1 = Math.max(0, Math.min(10000, t1Ms));
  const cT2 = Math.max(0, Math.min(10000, t2Ms));
  const deltaMs = Math.round(Math.abs(cT2 - cT1));

  let hrBpm: number | null = null;
  let hrDisplay = '— bpm';
  let qtcMs = Math.round(qtInputMs);

  if (deltaMs > 0) {
    hrBpm = Math.round(60000 / deltaMs);
    hrDisplay = `${hrBpm} bpm`;
    const rrSec = deltaMs / 1000;
    qtcMs = Math.round(qtInputMs / Math.sqrt(rrSec));
  }

  const deltaMv = Number((v2Mv - v1Mv).toFixed(3));
  const marchingSpikesMs: number[] = [];
  if (deltaMs >= 120) {
    const anchor = Math.min(cT1, cT2);
    for (let k = -3; k <= 6; k++) {
      const pos = anchor + k * deltaMs;
      if (pos >= 0 && pos <= 10000 && pos !== cT1 && pos !== cT2) {
        marchingSpikesMs.push(pos);
      }
    }
  }

  return {
    deltaMs,
    hrBpm,
    hrDisplay,
    qtcMs,
    deltaMv,
    marchingSpikesMs,
  };
}

export function nudgeCaliperState(
  state: CaliperState,
  handle: 't1' | 't2' | 'v1' | 'v2',
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  shiftKey: boolean
): CaliperState {
  const next = { ...state };
  const timeStep = shiftKey ? 20 : 2;
  const voltStep = shiftKey ? 0.2 : 0.05;

  if (handle === 't1' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const dir = key === 'ArrowRight' ? 1 : -1;
    next.t1Ms = Math.max(0, Math.min(10000, state.t1Ms + dir * timeStep));
  } else if (handle === 't2' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const dir = key === 'ArrowRight' ? 1 : -1;
    next.t2Ms = Math.max(0, Math.min(10000, state.t2Ms + dir * timeStep));
  } else if (handle === 'v1' && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const dir = key === 'ArrowUp' ? 1 : -1;
    next.v1Mv = Number(Math.max(-5.0, Math.min(5.0, state.v1Mv + dir * voltStep)).toFixed(3));
  } else if (handle === 'v2' && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const dir = key === 'ArrowUp' ? 1 : -1;
    next.v2Mv = Number(Math.max(-5.0, Math.min(5.0, state.v2Mv + dir * voltStep)).toFixed(3));
  }
  return next;
}

export interface CaliperSubmissionInput {
  prMs: number;
  qrsMs: number;
  qtcMs: number;
  stMv: number;
  rhythmClass: RhythmClass;
}

export interface CaliperGradeReport {
  prPass: boolean;
  qrsPass: boolean;
  qtcPass: boolean;
  stPass: boolean;
  rhythmPass: boolean;
  overallPass: boolean;
  prErrorMs: number;
  qrsErrorMs: number;
  qtcErrorMs: number;
  stErrorMv: number;
}

export function gradeCaliperSubmission(
  record: PtbxlCaseRecord,
  sub: CaliperSubmissionInput
): CaliperGradeReport {
  const f = record.fiducials;
  const prErrorMs = Math.round(sub.prMs - f.prMs);
  const qrsErrorMs = Math.round(sub.qrsMs - f.qrsMs);
  const qtcErrorMs = Math.round(sub.qtcMs - f.qtcMs);
  const stErrorMv = Number((sub.stMv - f.stMv).toFixed(3));

  const prPass = Math.abs(prErrorMs) <= 20;
  const qrsPass = Math.abs(qrsErrorMs) <= 20;
  const qtcPass = Math.abs(qtcErrorMs) <= 24;
  const stPass = Math.abs(stErrorMv) <= 0.0501;
  const rhythmPass = sub.rhythmClass === record.rhythmClass;

  return {
    prPass,
    qrsPass,
    qtcPass,
    stPass,
    rhythmPass,
    overallPass: prPass && qrsPass && qtcPass && stPass && rhythmPass,
    prErrorMs,
    qrsErrorMs,
    qtcErrorMs,
    stErrorMv,
  };
}

export function render12LeadCaliperCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveforms: CaseWaveforms12Lead,
  caliper: CaliperState,
  marchingSpikesMs: number[],
  showGroundTruth: boolean,
  record: PtbxlCaseRecord,
  darkTheme: boolean
): void {
  ctx.fillStyle = darkTheme ? '#111827' : '#FFFDF9';
  ctx.fillRect(0, 0, width, height);

  // Standard 25 mm/s, 10 mm/mV ECG paper minor (40ms) and major (200ms) grid
  ctx.strokeStyle = 'rgba(225, 29, 72, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const minorStepX = Math.max(6, width / 125);
  const minorStepY = Math.max(6, height / 60);
  for (let x = 0; x <= width; x += minorStepX) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += minorStepY) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(225, 29, 72, 0.32)';
  ctx.beginPath();
  const majorStepX = minorStepX * 5;
  const majorStepY = minorStepY * 5;
  for (let x = 0; x <= width; x += majorStepX) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += majorStepY) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Render 4 rows x 3 columns for the 12 leads + bottom Lead II rhythm strip
  const rows = 4;
  const cols = 3;
  const cellW = width / cols;
  const cellH = (height * 0.76) / rows;

  ctx.strokeStyle = darkTheme ? '#22C55E' : '#0F172A';
  ctx.lineWidth = 1.4;

  for (let l = 0; l < LEAD_NAMES.length; l++) {
    const leadName = LEAD_NAMES[l]!;
    const col = Math.floor(l / rows);
    const row = l % rows;
    const x0 = col * cellW;
    const yMid = row * cellH + cellH * 0.52;
    const samples = waveforms[leadName];

    ctx.beginPath();
    const sliceSamples = 1250; // 2.5s per column
    for (let s = 0; s < sliceSamples; s += 2) {
      const px = x0 + (s / sliceSamples) * (cellW - 8) + 4;
      const py = yMid - (samples[s] ?? 0) * (cellH * 0.32);
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Bottom full-width 10-second Lead II rhythm strip (where T1/T2 calipers operate directly)
  const stripTop = height * 0.78;
  const stripMid = height * 0.89;
  const stripScale = height * 0.075;
  const leadII = waveforms.II;

  ctx.strokeStyle = darkTheme ? '#38BDF8' : '#1E3A8A';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let s = 0; s < leadII.length; s += 4) {
    const px = (s / 5000) * width;
    const py = stripMid - (leadII[s] ?? 0) * stripScale;
    if (s === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Marching R-R spikes (dashed)
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const mMs of marchingSpikesMs) {
    const mx = (mMs / 10000) * width;
    ctx.moveTo(mx, stripTop);
    ctx.lineTo(mx, height);
  }
  ctx.stroke();

  // Primary T1 & T2 vertical time calipers
  const xT1 = (caliper.t1Ms / 10000) * width;
  const xT2 = (caliper.t2Ms / 10000) * width;
  ctx.strokeStyle = '#818CF8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xT1, 0);
  ctx.lineTo(xT1, height);
  ctx.moveTo(xT2, 0);
  ctx.lineTo(xT2, height);
  ctx.stroke();

  // Horizontal V1 & V2 amplitude calipers on the bottom Lead II strip
  const yV1 = stripMid - caliper.v1Mv * stripScale;
  const yV2 = stripMid - caliper.v2Mv * stripScale;
  ctx.strokeStyle = '#F87171';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, yV1);
  ctx.lineTo(width, yV1);
  ctx.moveTo(0, yV2);
  ctx.lineTo(width, yV2);
  ctx.stroke();

  if (showGroundTruth) {
    const f = record.fiducials;
    const xQrsOn = ((f.qrsOnSample * 2) / 10000) * width;
    const xTOff = ((f.tOffSample * 2) / 10000) * width;
    ctx.strokeStyle = '#22C55E';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xQrsOn, stripTop);
    ctx.lineTo(xQrsOn, height);
    ctx.moveTo(xTOff, stripTop);
    ctx.lineTo(xTOff, height);
    ctx.stroke();
  }
}
