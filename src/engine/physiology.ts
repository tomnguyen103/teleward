import type { AlarmPriority, RhythmClass, VitalState } from '../types/teleward.ts';

export interface RhythmTargetProfile {
  hr: number;
  sbp: number;
  dbp: number;
  spo2: number;
  etco2: number;
  rr: number;
  pulseless: boolean;
  tauBpSec: number;
  tauGasSec: number;
  alarmPriority: AlarmPriority;
  label: string;
}

export const RHYTHM_PROFILES: Record<RhythmClass, RhythmTargetProfile> = {
  NSR: {
    hr: 74,
    sbp: 122,
    dbp: 78,
    spo2: 98,
    etco2: 38,
    rr: 16,
    pulseless: false,
    tauBpSec: 2.8,
    tauGasSec: 4.0,
    alarmPriority: 'NORMAL',
    label: 'Normal Sinus Rhythm',
  },
  SB: {
    hr: 42,
    sbp: 84,
    dbp: 52,
    spo2: 92,
    etco2: 33,
    rr: 12,
    pulseless: false,
    tauBpSec: 4.5,
    tauGasSec: 6.0,
    alarmPriority: 'WARNING',
    label: 'Sinus Bradycardia',
  },
  SVT: {
    hr: 188,
    sbp: 88,
    dbp: 58,
    spo2: 93,
    etco2: 31,
    rr: 22,
    pulseless: false,
    tauBpSec: 4.0,
    tauGasSec: 5.5,
    alarmPriority: 'WARNING',
    label: 'Supraventricular Tachycardia',
  },
  AFIB: {
    hr: 138,
    sbp: 102,
    dbp: 66,
    spo2: 95,
    etco2: 35,
    rr: 18,
    pulseless: false,
    tauBpSec: 4.5,
    tauGasSec: 6.0,
    alarmPriority: 'WARNING',
    label: 'Atrial Fibrillation (RVR)',
  },
  AFLT: {
    hr: 146,
    sbp: 98,
    dbp: 64,
    spo2: 94,
    etco2: 34,
    rr: 19,
    pulseless: false,
    tauBpSec: 4.5,
    tauGasSec: 6.0,
    alarmPriority: 'WARNING',
    label: 'Atrial Flutter (2:1)',
  },
  AVB3: {
    hr: 32,
    sbp: 70,
    dbp: 42,
    spo2: 88,
    etco2: 27,
    rr: 14,
    pulseless: false,
    tauBpSec: 3.5,
    tauGasSec: 5.0,
    alarmPriority: 'WARNING',
    label: '3rd-Degree Complete Heart Block',
  },
  VT_MONO: {
    hr: 172,
    sbp: 76,
    dbp: 48,
    spo2: 89,
    etco2: 26,
    rr: 24,
    pulseless: false,
    tauBpSec: 3.2,
    tauGasSec: 4.5,
    alarmPriority: 'CRISIS',
    label: 'Monomorphic Ventricular Tachycardia',
  },
  TORSADES: {
    hr: 224,
    sbp: 54,
    dbp: 32,
    spo2: 84,
    etco2: 19,
    rr: 26,
    pulseless: false,
    tauBpSec: 2.5,
    tauGasSec: 3.8,
    alarmPriority: 'CRISIS',
    label: 'Torsades de Pointes (Polymorphic VT)',
  },
  VFIB: {
    hr: 0,
    sbp: 0,
    dbp: 0,
    spo2: 68,
    etco2: 6,
    rr: 0,
    pulseless: true,
    tauBpSec: 3.2,
    tauGasSec: 5.5,
    alarmPriority: 'CRISIS',
    label: 'Ventricular Fibrillation (Pulseless)',
  },
  ASYSTOLE: {
    hr: 0,
    sbp: 0,
    dbp: 0,
    spo2: 64,
    etco2: 4,
    rr: 0,
    pulseless: true,
    tauBpSec: 3.0,
    tauGasSec: 5.0,
    alarmPriority: 'CRISIS',
    label: 'Ventricular Asystole',
  },
  PEA: {
    hr: 46,
    sbp: 0,
    dbp: 0,
    spo2: 70,
    etco2: 8,
    rr: 0,
    pulseless: true,
    tauBpSec: 3.2,
    tauGasSec: 5.2,
    alarmPriority: 'CRISIS',
    label: 'Pulseless Electrical Activity',
  },
  STEMI_ANT: {
    hr: 98,
    sbp: 96,
    dbp: 62,
    spo2: 93,
    etco2: 34,
    rr: 20,
    pulseless: false,
    tauBpSec: 4.2,
    tauGasSec: 5.5,
    alarmPriority: 'WARNING',
    label: 'Anterior ST-Elevation MI',
  },
};

export function clampPhysiology(v: VitalState): VitalState {
  const hr = Math.max(0, Math.min(320, Math.round(Number.isFinite(v.hr) ? v.hr : 0)));
  const sbp = Math.max(0, Math.min(260, Math.round(Number.isFinite(v.sbp) ? v.sbp : 0)));
  const dbp = Math.max(0, Math.min(160, Math.min(sbp, Math.round(Number.isFinite(v.dbp) ? v.dbp : 0))));
  const map = sbp > 0 ? Math.round(dbp + (sbp - dbp) / 3) : 0;
  const spo2 = Math.max(0, Math.min(100, Math.round(Number.isFinite(v.spo2) ? v.spo2 : 0)));
  const etco2 = Math.max(0, Math.min(80, Math.round(Number.isFinite(v.etco2) ? v.etco2 : 0)));
  const rr = Math.max(0, Math.min(60, Math.round(Number.isFinite(v.rr) ? v.rr : 0)));
  return {
    rhythm: v.rhythm,
    hr,
    sbp,
    dbp,
    map,
    spo2,
    etco2,
    rr,
    paced: v.paced,
  };
}

export function createInitialVitals(rhythm: RhythmClass): VitalState {
  const p = RHYTHM_PROFILES[rhythm];
  // Pulseless rhythms begin with residual arterial pressure right at arrest onset so Windkessel decay is observable
  const initialSbp = p.pulseless ? 58 : p.sbp;
  const initialDbp = p.pulseless ? 36 : p.dbp;
  const initialEtco2 = p.pulseless ? 22 : p.etco2;
  const initialSpo2 = p.pulseless ? 88 : p.spo2;
  return clampPhysiology({
    rhythm,
    hr: p.hr,
    sbp: initialSbp,
    dbp: initialDbp,
    map: Math.round(initialDbp + (initialSbp - initialDbp) / 3),
    spo2: initialSpo2,
    etco2: initialEtco2,
    rr: p.rr,
    paced: false,
  });
}

interface OdeVector {
  hr: number;
  sbp: number;
  dbp: number;
  spo2: number;
  etco2: number;
  rr: number;
}

function computeDerivatives(
  state: OdeVector,
  rhythm: RhythmClass,
  elapsedUnrescuedSec: number,
  paced = false
): OdeVector {
  const target = RHYTHM_PROFILES[rhythm];
  const targetHr = paced ? 70 : target.hr;
  // Progressive ischemic decay if an unstable non-NSR rhythm remains unrescued
  const ischemicPenalty =
    rhythm !== 'NSR' && !target.pulseless && elapsedUnrescuedSec > 18
      ? Math.min(35, (elapsedUnrescuedSec - 18) * 1.2)
      : 0;

  const targetSbp = Math.max(0, target.sbp - ischemicPenalty);
  const targetDbp = Math.max(0, target.dbp - ischemicPenalty * 0.65);
  const targetEtco2 = Math.max(0, target.etco2 - ischemicPenalty * 0.35);
  const targetSpo2 = Math.max(0, target.spo2 - ischemicPenalty * 0.25);

  return {
    hr: (targetHr - state.hr) / 2.0,
    sbp: (targetSbp - state.sbp) / target.tauBpSec,
    dbp: (targetDbp - state.dbp) / target.tauBpSec,
    spo2: (targetSpo2 - state.spo2) / target.tauGasSec,
    etco2: (targetEtco2 - state.etco2) / target.tauGasSec,
    rr: (target.rr - state.rr) / 3.0,
  };
}

function addScaled(a: OdeVector, b: OdeVector, scale: number): OdeVector {
  return {
    hr: a.hr + b.hr * scale,
    sbp: a.sbp + b.sbp * scale,
    dbp: a.dbp + b.dbp * scale,
    spo2: a.spo2 + b.spo2 * scale,
    etco2: a.etco2 + b.etco2 * scale,
    rr: a.rr + b.rr * scale,
  };
}

/**
 * 4th-order Runge-Kutta (RK4) step for coupled cardiopulmonary hemodynamics.
 */
export function stepHemodynamicsRk4(
  current: OdeVector,
  rhythm: RhythmClass,
  dtSec: number,
  elapsedUnrescuedSec: number,
  jitterFn: () => number,
  paced = false
): OdeVector {
  const k1 = computeDerivatives(current, rhythm, elapsedUnrescuedSec, paced);
  const k2 = computeDerivatives(addScaled(current, k1, dtSec * 0.5), rhythm, elapsedUnrescuedSec + dtSec * 0.5, paced);
  const k3 = computeDerivatives(addScaled(current, k2, dtSec * 0.5), rhythm, elapsedUnrescuedSec + dtSec * 0.5, paced);
  const k4 = computeDerivatives(addScaled(current, k3, dtSec), rhythm, elapsedUnrescuedSec + dtSec, paced);

  const jitter = (jitterFn() - 0.5) * 0.12;
  return {
    hr: Math.max(0, Math.min(320, current.hr + (dtSec / 6) * (k1.hr + 2 * k2.hr + 2 * k3.hr + k4.hr) + jitter)),
    sbp: Math.max(0, Math.min(260, current.sbp + (dtSec / 6) * (k1.sbp + 2 * k2.sbp + 2 * k3.sbp + k4.sbp) + jitter)),
    dbp: Math.max(0, Math.min(160, current.dbp + (dtSec / 6) * (k1.dbp + 2 * k2.dbp + 2 * k3.dbp + k4.dbp))),
    spo2: Math.max(0, Math.min(100, current.spo2 + (dtSec / 6) * (k1.spo2 + 2 * k2.spo2 + 2 * k3.spo2 + k4.spo2))),
    etco2: Math.max(0, Math.min(80, current.etco2 + (dtSec / 6) * (k1.etco2 + 2 * k2.etco2 + 2 * k3.etco2 + k4.etco2))),
    rr: Math.max(0, Math.min(60, current.rr + (dtSec / 6) * (k1.rr + 2 * k2.rr + 2 * k3.rr + k4.rr))),
  };
}

export interface RealtimeWaveformSample {
  ecgMv: number;
  abpMmHg: number;
  spo2Wave: number;
  etco2MmHg: number;
}

/**
 * Synthesizes 500 Hz coupled physiological traces (ECG Lead II, arterial ABP dicrotic wave, SpO2 pleth, EtCO2 capnogram).
 */
export function synthesizeRealtimeSample(vitals: VitalState, timeSec: number): RealtimeWaveformSample {
  const { rhythm, hr, sbp, dbp, etco2, rr } = vitals;
  const t = Math.max(0, timeSec);
  const afibMod =
    rhythm === 'AFIB' ? 0.14 * Math.sin(t * 2.3) + 0.09 * Math.cos(t * 3.7) : 0;

  let ecgMv = 0;
  if (rhythm === 'ASYSTOLE') {
    ecgMv = 0.012 * Math.sin(2 * Math.PI * 0.4 * t);
  } else if (rhythm === 'VFIB') {
    ecgMv =
      0.38 * Math.sin(2 * Math.PI * 4.4 * t) +
      0.24 * Math.sin(2 * Math.PI * 6.8 * t + 0.9) +
      0.16 * Math.cos(2 * Math.PI * 9.2 * t);
  } else if (rhythm === 'TORSADES') {
    const freqHz = Math.max(0.5, (hr || 224) / 60);
    const spindle = 0.35 + 0.65 * Math.sin(2 * Math.PI * 0.8 * t);
    ecgMv = 1.15 * spindle * Math.sin(2 * Math.PI * freqHz * t);
  } else if (rhythm === 'VT_MONO') {
    const freqHz = Math.max(0.5, (hr || 172) / 60);
    ecgMv =
      1.1 * Math.sin(2 * Math.PI * freqHz * t) -
      0.28 * Math.sin(4 * Math.PI * freqHz * t + 0.4);
  } else {
    const effectiveHr = Math.max(30, vitals.paced ? 70 : hr || 60);
    const beatPeriod = 60 / effectiveHr;
    const phase = (((t % beatPeriod) / beatPeriod + afibMod) % 1 + 1) % 1;
    const gauss = (center: number, width: number) => Math.exp(-0.5 * ((phase - center) / width) ** 2);
    const atrialPhase = (((t * (78 / 60)) % 1) + 1) % 1;
    const pWave =
      rhythm === 'AFIB' || rhythm === 'AFLT' || rhythm === 'SVT'
        ? 0
        : rhythm === 'AVB3' && !vitals.paced
          ? 0.14 * Math.exp(-0.5 * ((atrialPhase - 0.16) / 0.025) ** 2)
          : 0.14 * gauss(0.16, 0.025);
    const qWave = -0.11 * gauss(0.32, 0.01);
    const rWave = 1.18 * gauss(0.35, 0.014);
    const sWave = -0.22 * gauss(0.38, 0.012);
    const stElev = rhythm === 'STEMI_ANT' ? 0.28 * gauss(0.45, 0.05) : 0;
    const tWave = 0.26 * gauss(0.56, 0.042);
    const paceSpike = vitals.paced && Math.abs(phase - 0.31) < 0.004 ? 0.85 : 0;
    ecgMv = pWave + qWave + rWave + sWave + stElev + tWave + paceSpike;
  }

  // Coupled arterial blood pressure (ABP) with systolic upstroke and dicrotic notch
  let abpMmHg = dbp;
  let spo2Wave = 0;
  if (sbp > 15 && hr > 0 && rhythm !== 'VFIB' && rhythm !== 'ASYSTOLE' && rhythm !== 'PEA') {
    const effectivePulseHr = Math.max(30, vitals.paced ? 70 : hr);
    const beatPeriod = 60 / effectivePulseHr;
    const pulsePhase = ((((t - 0.12 + beatPeriod) % beatPeriod) / beatPeriod + afibMod) % 1 + 1) % 1;
    const upstroke = Math.exp(-0.5 * ((pulsePhase - 0.18) / 0.07) ** 2);
    const dicrotic = 0.36 * Math.exp(-0.5 * ((pulsePhase - 0.42) / 0.11) ** 2);
    const shape = Math.min(1, (upstroke + dicrotic) / 1.08);
    abpMmHg = dbp + (sbp - dbp) * shape;

    const plethPhase = ((((t - 0.22 + beatPeriod) % beatPeriod) / beatPeriod + afibMod) % 1 + 1) % 1;
    spo2Wave =
      Math.exp(-0.5 * ((plethPhase - 0.22) / 0.08) ** 2) +
      0.3 * Math.exp(-0.5 * ((plethPhase - 0.46) / 0.12) ** 2);
  }

  // Rectangular plateau capnogram (EtCO2)
  let etco2MmHg = 0;
  if (etco2 > 2 && rr > 0) {
    const breathPeriod = 60 / Math.max(6, rr);
    const bPhase = (timeSec % breathPeriod) / breathPeriod;
    if (bPhase >= 0.15 && bPhase < 0.62) {
      const rise = Math.min(1, (bPhase - 0.15) / 0.08);
      const slope = 0.92 + 0.08 * ((bPhase - 0.15) / 0.47);
      etco2MmHg = etco2 * rise * slope;
    } else if (bPhase >= 0.62 && bPhase < 0.7) {
      const fall = Math.max(0, 1 - (bPhase - 0.62) / 0.08);
      etco2MmHg = etco2 * fall;
    }
  }

  return {
    ecgMv,
    abpMmHg,
    spo2Wave,
    etco2MmHg,
  };
}
