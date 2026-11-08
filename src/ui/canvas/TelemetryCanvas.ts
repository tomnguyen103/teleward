import {
  TelemetryRingBuffer,
  stepTelemetryFrame,
  synthesizeRealtimeSample,
} from '../../engine/physiology.ts';
import {
  LEAD_NAMES,
  type PtbxlCaseRecord,
} from '../../types/teleward.ts';
import type { CaseWaveforms12Lead } from '../../data/ptbxlLoader.ts';
import {
  type CaliperHandleState,
  type CaliperState,
  type CaliperComputedMetrics,
  type CaliperSubmissionInput,
  type CaliperGradeReport,
  computeCaliperMetrics,
  nudgeCaliperState,
  gradeCaliperSubmission,
} from '../../engine/caliperGrading.ts';

export {
  TelemetryRingBuffer,
  stepTelemetryFrame,
  synthesizeRealtimeSample,
  type CaliperHandleState,
  type CaliperState,
  type CaliperComputedMetrics,
  type CaliperSubmissionInput,
  type CaliperGradeReport,
  computeCaliperMetrics,
  nudgeCaliperState,
  gradeCaliperSubmission,
};

function isInEraseBar(
  sampleIdx: number,
  writeCursor: number,
  eraseGap: number,
  capacity: number
): boolean {
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

export function syncCanvasHiDpi(
  canvas: HTMLCanvasElement,
  logicalWidth: number,
  logicalHeight: number,
  ctx?: CanvasRenderingContext2D | null,
  adaptClientWidth = false
): { width: number; height: number; dpr: number } {
  const effLogicalW =
    adaptClientWidth && canvas.clientWidth > 120
      ? Math.round(canvas.clientWidth)
      : logicalWidth;
  const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const dpr = Math.max(1, Math.min(3, rawDpr));
  const targetW = Math.round(effLogicalW * dpr);
  const targetH = Math.round(logicalHeight * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  if (ctx && typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { width: effLogicalW, height: logicalHeight, dpr };
}

export function renderTelemetryBedCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  ring: TelemetryRingBuffer,
  selected: boolean
): void {
  ctx.fillStyle = '#04070A';
  ctx.fillRect(0, 0, width, height);

  // Subtle millimeter calibration grid + channel baseline dividers
  ctx.strokeStyle = selected ? 'rgba(16, 185, 129, 0.16)' : 'rgba(148, 166, 184, 0.07)';
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
    label: string;
    arr: Float32Array;
    color: string;
    centerY: number;
    scaleY: number;
    offsetVal: number;
  }> = [
    { label: 'II 1.0mV', arr: ring.ecg, color: '#00E676', centerY: height * 0.24, scaleY: -22, offsetVal: 0 },
    { label: 'ART mmHg', arr: ring.abp, color: '#FF5252', centerY: height * 0.56, scaleY: -0.25, offsetVal: 70 },
    { label: 'PLETH', arr: ring.spo2, color: '#00E5FF', centerY: height * 0.77, scaleY: -18, offsetVal: 0.3 },
    { label: 'CO2 mmHg', arr: ring.etco2, color: '#FFD740', centerY: height * 0.93, scaleY: -0.45, offsetVal: 20 },
  ];

  // 1 mV square calibration pulse at left edge of Lead II ECG channel
  const ecgBaseY = height * 0.24;
  const calTopY = ecgBaseY - 22;
  ctx.strokeStyle = '#00E676';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(4, ecgBaseY);
  ctx.lineTo(7, ecgBaseY);
  ctx.lineTo(7, calTopY);
  ctx.lineTo(15, calTopY);
  ctx.lineTo(15, ecgBaseY);
  ctx.lineTo(18, ecgBaseY);
  ctx.stroke();

  const headSample = (ring.writeCursor - 1 + ring.capacity) % ring.capacity;
  const headX = (headSample / ring.capacity) * width;

  for (let t = 0; t < traces.length; t++) {
    const tr = traces[t]!;
    ctx.strokeStyle = tr.color;
    ctx.lineWidth = t === 0 ? 1.75 : 1.35;
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

    // Phosphor leading cursor dot on active write head
    if (typeof ctx.arc === 'function' && typeof ctx.fill === 'function') {
      const headVal = tr.arr[headSample] ?? tr.offsetVal;
      const headY = tr.centerY + (headVal - tr.offsetVal) * tr.scaleY;
      ctx.fillStyle = tr.color;
      ctx.beginPath();
      ctx.arc(headX, headY, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (typeof ctx.fillText === 'function') {
      ctx.fillStyle = tr.color;
      ctx.font = '600 10px monospace';
      ctx.fillText(tr.label, 22, Math.max(11, tr.centerY - 12));
    }
  }

  if (typeof ctx.fillText === 'function') {
    ctx.fillStyle = '#94A6B8';
    ctx.font = '600 10px monospace';
    ctx.fillText('25 mm/s', width - 54, 12);
  }
}

export interface CaliperCanvasRenderOptions {
  paperSpeedMmPerSec?: 25 | 50;
  gainMmPerMv?: 5 | 10 | 20;
}

export interface CaliperStripGeometry {
  speedScale: number;
  gainScale: number;
  visibleDurationMs: number;
  stripSamples: number;
  stripTop: number;
  stripMid: number;
  stripScale: number;
  msToX: (ms: number) => number;
  xToMs: (x: number) => number;
  mvToY: (mv: number) => number;
  yToMv: (y: number) => number;
}

export function getCaliperStripGeometry(
  width: number,
  height: number,
  paperSpeedMmPerSec: 25 | 50 = 25,
  gainMmPerMv: 5 | 10 | 20 = 10
): CaliperStripGeometry {
  const speedScale = paperSpeedMmPerSec / 25;
  const gainScale = gainMmPerMv / 10;
  const visibleDurationMs = 10000 / speedScale;
  const stripSamples = Math.max(2500, Math.round(5000 / speedScale));
  const stripTop = height * 0.75;
  const stripMid = stripTop + (height - stripTop) * 0.5;
  const stripScale = Math.max(1, (height - stripTop) * 0.34 * gainScale);
  const safeWidth = Math.max(1, width);
  return {
    speedScale,
    gainScale,
    visibleDurationMs,
    stripSamples,
    stripTop,
    stripMid,
    stripScale,
    msToX: (ms: number) => (ms / visibleDurationMs) * safeWidth,
    xToMs: (x: number) => (x / safeWidth) * visibleDurationMs,
    mvToY: (mv: number) => stripMid - mv * stripScale,
    yToMv: (y: number) => (stripMid - y) / stripScale,
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
  darkTheme: boolean,
  options?: CaliperCanvasRenderOptions
): void {
  const paperSpeed = options?.paperSpeedMmPerSec ?? 25;
  const gain = options?.gainMmPerMv ?? 10;
  const geom = getCaliperStripGeometry(width, height, paperSpeed, gain);
  const { speedScale, gainScale, stripTop, stripMid, stripScale, stripSamples, msToX, mvToY } =
    geom;

  ctx.fillStyle = darkTheme ? '#0A0F16' : '#FFFDF9';
  ctx.fillRect(0, 0, width, height);

  // Calibrated ECG paper minor (1mm) and major (5mm) grid:
  // 250 minor squares across full width (40 ms/mm at 25 mm/s, 20 ms/mm at 50 mm/s)
  // and 10 minor squares per 1 mV at standard 10 mm/mV gain.
  ctx.strokeStyle = 'rgba(225, 29, 72, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const minorStepX = Math.max(2, width / 250);
  const minorStepY = Math.max(2, ((height - stripTop) * 0.34) / 10);
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
  const cellH = (height * 0.75) / rows;
  const mvPxCell = stripScale;

  ctx.strokeStyle = darkTheme ? '#00E676' : '#0F172A';
  ctx.lineWidth = 1.4;

  // Draw 1 mV square calibration step pulse at the start of each of the 4 rows
  for (let r = 0; r < rows; r++) {
    const yMid = r * cellH + cellH * 0.52;
    const yTop = yMid - mvPxCell;
    ctx.beginPath();
    ctx.moveTo(2, yMid);
    ctx.lineTo(5, yMid);
    ctx.lineTo(5, yTop);
    ctx.lineTo(5 + minorStepX * 5, yTop);
    ctx.lineTo(5 + minorStepX * 5, yMid);
    ctx.lineTo(8 + minorStepX * 5, yMid);
    ctx.stroke();
  }

  const colSamples = Math.max(1, Math.round(stripSamples / cols));

  for (let l = 0; l < LEAD_NAMES.length; l++) {
    const leadName = LEAD_NAMES[l]!;
    const col = Math.floor(l / rows);
    const row = l % rows;
    const x0 = col * cellW;
    const yMid = row * cellH + cellH * 0.52;
    const samples = waveforms[leadName];

    ctx.beginPath();
    for (let s = 0; s < colSamples; s += 2) {
      const px = x0 + (s / colSamples) * cellW;
      const py = yMid - (samples[s] ?? 0) * mvPxCell;
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    if (typeof ctx.fillText === 'function') {
      ctx.fillStyle = darkTheme ? '#ECF2F8' : '#111820';
      ctx.font = '600 11px monospace';
      ctx.fillText(leadName, x0 + 18, row * cellH + 14);
    }
  }

  // Bottom full-width Lead II rhythm strip (where T1/T2 calipers operate directly)
  const leadII = waveforms.II;

  // 1 mV calibration pulse on the bottom rhythm strip
  ctx.strokeStyle = darkTheme ? '#00E5FF' : '#0369A1';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(2, stripMid);
  ctx.lineTo(5, stripMid);
  ctx.lineTo(5, stripMid - stripScale);
  ctx.lineTo(13, stripMid - stripScale);
  ctx.lineTo(13, stripMid);
  ctx.lineTo(16, stripMid);
  ctx.stroke();

  if (typeof ctx.fillText === 'function') {
    ctx.fillStyle = darkTheme ? '#00E5FF' : '#0369A1';
    ctx.font = '600 11px monospace';
    ctx.fillText(`II (RHYTHM · ${paperSpeed} mm/s · ${gain} mm/mV)`, 20, stripTop + 14);
  }

  ctx.beginPath();
  for (let s = 0; s < stripSamples; s += 4) {
    const px = (s / stripSamples) * width;
    const py = mvToY(leadII[s] ?? 0);
    if (s === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Marching R-R spikes
  ctx.strokeStyle = 'rgba(255, 215, 64, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const mMs of marchingSpikesMs) {
    const mx = msToX(mMs);
    if (mx >= 0 && mx <= width) {
      ctx.moveTo(mx, stripTop);
      ctx.lineTo(mx, height);
    }
  }
  ctx.stroke();

  // Primary T1 & T2 vertical time calipers (diagnostic cyan #0EA5E9)
  const xT1 = msToX(caliper.t1Ms);
  const xT2 = msToX(caliper.t2Ms);
  ctx.strokeStyle = '#0EA5E9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xT1, 0);
  ctx.lineTo(xT1, height);
  ctx.moveTo(xT2, 0);
  ctx.lineTo(xT2, height);
  ctx.stroke();

  // Horizontal measurement bridge & grab handles between T1 and T2
  const bridgeY = stripTop - 14;
  ctx.strokeStyle = '#0EA5E9';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(xT1, bridgeY);
  ctx.lineTo(xT2, bridgeY);
  ctx.stroke();

  ctx.fillStyle = '#0EA5E9';
  ctx.fillRect(xT1 - 3, 2, 6, 6);
  ctx.fillRect(xT2 - 3, 2, 6, 6);
  ctx.fillRect(xT1 - 3, height - 8, 6, 6);
  ctx.fillRect(xT2 - 3, height - 8, 6, 6);

  if (typeof ctx.fillText === 'function') {
    const deltaMs = Math.round(Math.abs(caliper.t2Ms - caliper.t1Ms));
    const bpmText = deltaMs >= 150 ? ` · ${Math.round(60000 / deltaMs)} bpm` : '';
    const midX = Math.max(40, Math.min(width - 140, (xT1 + xT2) * 0.5 - 52));
    ctx.fillStyle = darkTheme ? '#0C1117' : '#FCFBF9';
    ctx.fillRect(midX - 4, bridgeY - 10, 128, 16);
    if (typeof ctx.strokeRect === 'function') {
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = 1;
      ctx.strokeRect(midX - 4, bridgeY - 10, 128, 16);
    }
    ctx.fillStyle = '#0EA5E9';
    ctx.font = '600 10px monospace';
    ctx.fillText(`Δt ${deltaMs} ms${bpmText}`, midX + 2, bridgeY + 2);
    ctx.fillText(`T1 ${Math.round(caliper.t1Ms)}ms`, Math.min(width - 72, xT1 + 6), height - 10);
    ctx.fillText(`T2 ${Math.round(caliper.t2Ms)}ms`, Math.min(width - 72, xT2 + 6), height - 10);
  }

  // Horizontal V1 & V2 amplitude calipers on the bottom Lead II strip
  const yV1 = mvToY(caliper.v1Mv);
  const yV2 = mvToY(caliper.v2Mv);
  ctx.strokeStyle = '#FF5252';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, yV1);
  ctx.lineTo(width, yV1);
  ctx.moveTo(0, yV2);
  ctx.lineTo(width, yV2);
  ctx.stroke();

  if (typeof ctx.fillText === 'function') {
    ctx.fillStyle = '#FF5252';
    ctx.font = '600 10px monospace';
    ctx.fillText(`V1 ${caliper.v1Mv >= 0 ? '+' : ''}${caliper.v1Mv.toFixed(2)}mV`, width - 168, Math.max(stripTop + 12, yV1 - 4));
    ctx.fillText(`V2 ${caliper.v2Mv >= 0 ? '+' : ''}${caliper.v2Mv.toFixed(2)}mV`, width - 82, Math.max(stripTop + 12, yV2 - 4));
  }

  if (showGroundTruth) {
    const f = record.fiducials;
    const xQrsOn = msToX(f.qrsOnSample * 2);
    const xTOff = msToX(f.tOffSample * 2);
    ctx.strokeStyle = '#00E676';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xQrsOn, stripTop);
    ctx.lineTo(xQrsOn, height);
    ctx.moveTo(xTOff, stripTop);
    ctx.lineTo(xTOff, height);
    ctx.stroke();
  }
}
