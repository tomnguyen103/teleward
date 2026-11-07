import type { PtbxlCaseRecord, RhythmClass } from '../types/teleward.ts';

export interface CaliperHandleState {
  t1Ms: number;
  t2Ms: number;
  v1Mv: number;
  v2Mv: number;
}

export type CaliperState = CaliperHandleState;

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
  state: CaliperHandleState,
  handle: 't1' | 't2' | 'v1' | 'v2',
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  shiftKey: boolean
): CaliperHandleState {
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

export const PR_TOLERANCE_MS = 20;
export const QRS_TOLERANCE_MS = 20;
export const QTC_TOLERANCE_MS = 24;
export const ST_TOLERANCE_MV = 0.05;

export function gradeCaliperSubmission(
  record: PtbxlCaseRecord,
  sub: CaliperSubmissionInput
): CaliperGradeReport {
  const f = record.fiducials;
  const rawPrErr = Math.abs(sub.prMs - f.prMs);
  const rawQrsErr = Math.abs(sub.qrsMs - f.qrsMs);
  const rawQtcErr = Math.abs(sub.qtcMs - f.qtcMs);
  const rawStErr = Math.abs(sub.stMv - f.stMv);

  const prValid = Number.isFinite(sub.prMs) && sub.prMs >= 0;
  const qrsValid =
    Number.isFinite(sub.qrsMs) && (f.qrsMs === 0 ? sub.qrsMs >= 0 : sub.qrsMs > 0);
  const qtcValid =
    Number.isFinite(sub.qtcMs) && (f.qtcMs === 0 ? sub.qtcMs >= 0 : sub.qtcMs > 0);
  const stValid = Number.isFinite(sub.stMv);

  const prPass = prValid && rawPrErr <= PR_TOLERANCE_MS + 1e-6;
  const qrsPass = qrsValid && rawQrsErr <= QRS_TOLERANCE_MS + 1e-6;
  const qtcPass = qtcValid && rawQtcErr <= QTC_TOLERANCE_MS + 1e-6;
  const stPass = stValid && rawStErr <= ST_TOLERANCE_MV + 1e-6;
  const rhythmPass = sub.rhythmClass === record.rhythmClass;

  const prErrorMs = Math.round(sub.prMs - f.prMs);
  const qrsErrorMs = Math.round(sub.qrsMs - f.qrsMs);
  const qtcErrorMs = Math.round(sub.qtcMs - f.qtcMs);
  const stErrorMv = Number((sub.stMv - f.stMv).toFixed(3));

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
