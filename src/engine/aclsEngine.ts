import {
  ACLS_INTERVENTIONS,
  RHYTHM_CLASSES,
  type AclsInterventionId,
  type AlarmPriority,
  type CausalEvent,
  type Rfc7807Error,
  type RhythmClass,
  type SimulationOptions,
  type SimulationResult,
  type TrajectoryPoint,
  type VitalState,
} from '../types/teleward.ts';
import { mulberry32 } from './prng.ts';
import {
  RHYTHM_PROFILES,
  clampPhysiology,
  createInitialVitals,
  stepHemodynamicsRk4,
} from './physiology.ts';

export interface InterventionMetadata {
  id: AclsInterventionId;
  label: string;
  shortLabel: string;
  category: 'DRUG' | 'ELECTRICAL';
  indicationHint: string;
}

export const ACLS_INTERVENTION_METADATA: readonly InterventionMetadata[] = [
  {
    id: 'adenosine_6mg',
    label: 'Adenosine 6 mg IV Push',
    shortLabel: 'Adenosine 6mg',
    category: 'DRUG',
    indicationHint: 'Regular narrow-complex SVT (AV nodal blockade)',
  },
  {
    id: 'amiodarone_300mg',
    label: 'Amiodarone 300 mg IV',
    shortLabel: 'Amiodarone 300mg',
    category: 'DRUG',
    indicationHint: 'Monomorphic VT, AFib/AFlutter rate/rhythm, or STEMI ectopy',
  },
  {
    id: 'epinephrine_1mg',
    label: 'Epinephrine 1 mg IV (1:10,000)',
    shortLabel: 'Epinephrine 1mg',
    category: 'DRUG',
    indicationHint: 'Non-shockable arrest (Asystole / PEA) or refractory VF/VT',
  },
  {
    id: 'atropine_1mg',
    label: 'Atropine 1 mg IV Bolus',
    shortLabel: 'Atropine 1mg',
    category: 'DRUG',
    indicationHint: 'Symptomatic Sinus Bradycardia (ineffective in infranodal AVB3)',
  },
  {
    id: 'magnesium_2g',
    label: 'Magnesium Sulfate 2 g IV',
    shortLabel: 'Magnesium 2g',
    category: 'DRUG',
    indicationHint: 'Polymorphic VT / Torsades de Pointes with prolonged QTc',
  },
  {
    id: 'sync_cardioversion',
    label: 'Synchronized Cardioversion (100 J)',
    shortLabel: 'Sync Cardioversion',
    category: 'ELECTRICAL',
    indicationHint: 'Unstable SVT, AFib, AFlutter, or pulsed Monomorphic VT',
  },
  {
    id: 'defibrillation',
    label: 'Unsynchronized Defibrillation (200 J Biphasic)',
    shortLabel: 'Defibrillate 200J',
    category: 'ELECTRICAL',
    indicationHint: 'Pulseless VF, Pulseless VT, or Polymorphic Torsades',
  },
  {
    id: 'transcutaneous_pacing',
    label: 'Transcutaneous Pacing (TCP 70 mA @ 70 bpm)',
    shortLabel: 'TCP Pacing',
    category: 'ELECTRICAL',
    indicationHint: 'High-grade / 3rd-Degree AV Block or atropine-refractory Bradycardia',
  },
] as const;

export class TelewardCliValidationError extends Error {
  public readonly problem: Rfc7807Error;

  constructor(detail: string, code = 'VALIDATION_ERROR') {
    super(detail);
    this.name = 'TelewardCliValidationError';
    this.problem = {
      type: `https://teleward.clinic/errors/${code.toLowerCase()}`,
      title: 'Invalid ACLS Simulation Flag',
      status: 422,
      detail,
      code,
    };
  }
}

export interface ValidatedSimConfig {
  scenario: RhythmClass;
  intervention: AclsInterventionId | null;
  atSec: number;
  durationSec: number;
  seed: number;
}

export function validateSimulationOptions(opts: SimulationOptions): ValidatedSimConfig {
  const normalizedScenario = String(opts.scenario ?? '')
    .trim()
    .toUpperCase() as RhythmClass;
  if (!RHYTHM_CLASSES.includes(normalizedScenario)) {
    throw new TelewardCliValidationError(
      `Unsupported --scenario "${String(opts.scenario)}". Allowed: ${RHYTHM_CLASSES.join(', ')}.`,
      'INVALID_SCENARIO'
    );
  }

  let normalizedIntervention: AclsInterventionId | null = null;
  if (opts.intervention !== undefined && opts.intervention !== null && opts.intervention !== '') {
    const cand = String(opts.intervention).trim().toLowerCase() as AclsInterventionId;
    if (!ACLS_INTERVENTIONS.includes(cand)) {
      throw new TelewardCliValidationError(
        `Unsupported --intervention "${String(opts.intervention)}". Allowed: ${ACLS_INTERVENTIONS.join(', ')}.`,
        'INVALID_INTERVENTION'
      );
    }
    normalizedIntervention = cand;
  }

  const durationSec = opts.durationSec ?? 45;
  if (!Number.isFinite(durationSec) || durationSec < 1 || durationSec > 3600) {
    throw new TelewardCliValidationError(
      `Invalid --duration "${String(opts.durationSec)}". Must be between 1 and 3600 seconds.`,
      'INVALID_DURATION'
    );
  }

  const defaultAtSec = normalizedIntervention === null ? Math.min(10, durationSec) : 10;
  const atSec = opts.atSec ?? defaultAtSec;
  if (!Number.isFinite(atSec) || atSec < 0 || atSec > durationSec) {
    throw new TelewardCliValidationError(
      `Invalid --at "${String(opts.atSec)}". Must be between 0 and duration (${durationSec}s).`,
      'INVALID_AT_SEC'
    );
  }

  if (
    typeof opts.seed !== 'number' ||
    !Number.isInteger(opts.seed) ||
    opts.seed < 0 ||
    opts.seed > 4294967295
  ) {
    throw new TelewardCliValidationError(
      `Invalid --seed "${String(opts.seed)}". Must be an unsigned 32-bit integer [0..4294967295].`,
      'INVALID_SEED'
    );
  }

  return {
    scenario: normalizedScenario,
    intervention: normalizedIntervention,
    atSec,
    durationSec,
    seed: opts.seed >>> 0,
  };
}

export interface TransitionDecision {
  nextRhythm: RhythmClass;
  paced: boolean;
  converted: boolean;
  ahaViolationCode: string | null;
  rationale: string;
}

export function applyTransitionToContinuousState(
  state: {
    hr: number;
    sbp: number;
    dbp: number;
    spo2: number;
    etco2: number;
    rr: number;
  },
  decision: TransitionDecision
): {
  hr: number;
  sbp: number;
  dbp: number;
  spo2: number;
  etco2: number;
  rr: number;
} {
  if (decision.converted) {
    const nsrProfile = RHYTHM_PROFILES.NSR;
    return {
      hr: decision.paced ? 70 : nsrProfile.hr,
      sbp: Math.max(106, state.sbp),
      dbp: Math.max(68, state.dbp),
      spo2: Math.max(96, state.spo2),
      etco2: Math.max(36, state.etco2),
      rr: nsrProfile.rr,
    };
  }
  if (decision.ahaViolationCode) {
    return {
      ...state,
      sbp: Math.max(0, state.sbp - 28),
      dbp: Math.max(0, state.dbp - 18),
    };
  }
  return { ...state };
}

export function getCaseIdForRhythm(rhythm: RhythmClass, bedIndex = 0): string {
  const classIdx = Math.max(0, RHYTHM_CLASSES.indexOf(rhythm));
  const caseNumber = classIdx * 2 + (Math.abs(bedIndex) % 2) + 1;
  return `ptbxl-${String(caseNumber).padStart(3, '0')}`;
}

export function evaluateAclsTransition(
  currentRhythm: RhythmClass,
  action: AclsInterventionId,
  currentSbp: number
): TransitionDecision {
  // 1. Forbidden unsynchronized defibrillation on perfusing organized rhythms
  if (
    action === 'defibrillation' &&
    (currentRhythm === 'NSR' ||
      currentRhythm === 'SB' ||
      currentRhythm === 'SVT' ||
      currentRhythm === 'AFIB' ||
      currentRhythm === 'AFLT' ||
      currentRhythm === 'AVB3' ||
      currentRhythm === 'STEMI_ANT')
  ) {
    return {
      nextRhythm: 'VFIB',
      paced: false,
      converted: false,
      ahaViolationCode: 'AHA_UNSYNC_SHOCK_ON_PERFUSING',
      rationale:
        'Unsynchronized high-energy shock on a perfusing organized rhythm strikes the vulnerable T-wave (R-on-T) and precipitates Ventricular Fibrillation.',
    };
  }

  // 2. Forbidden defibrillation or cardioversion on non-shockable arrest (Asystole / PEA)
  if (
    (action === 'defibrillation' || action === 'sync_cardioversion') &&
    (currentRhythm === 'ASYSTOLE' || currentRhythm === 'PEA')
  ) {
    return {
      nextRhythm: 'ASYSTOLE',
      paced: false,
      converted: false,
      ahaViolationCode: 'AHA_SHOCK_NON_SHOCKABLE',
      rationale:
        'Asystole and PEA are non-shockable arrest rhythms; shocking delays CPR and epinephrine while stunning residual myocardium.',
    };
  }

  // 3. Torsades de Pointes specific rules
  if (currentRhythm === 'TORSADES') {
    if (action === 'magnesium_2g' || action === 'defibrillation') {
      return {
        nextRhythm: 'NSR',
        paced: false,
        converted: true,
        ahaViolationCode: null,
        rationale:
          action === 'magnesium_2g'
            ? 'Magnesium Sulfate 2 g IV suppresses early afterdepolarizations (EADs) and terminates polymorphic Torsades de Pointes.'
            : 'Unsynchronized biphasic defibrillation depolarizes chaotic polymorphic re-entry and restores sinus capture.',
      };
    }
    if (action === 'amiodarone_300mg') {
      return {
        nextRhythm: 'VFIB',
        paced: false,
        converted: false,
        ahaViolationCode: 'AHA_TORSADES_AMIODARONE_CONTRAINDICATED',
        rationale:
          'Class III potassium-channel blockade (Amiodarone) further prolongs the QTc interval in Torsades de Pointes and degenerates into coarse VF.',
      };
    }
    if (action === 'adenosine_6mg') {
      return {
        nextRhythm: 'VFIB',
        paced: false,
        converted: false,
        ahaViolationCode: 'AHA_TORSADES_CONTRAINDICATED',
        rationale:
          'Adenosine causes vasodilatory hypotension in wide-complex polymorphic VT and precipitates arrest.',
      };
    }
  }

  // 4. Third-degree AV Block (AVB3)
  if (currentRhythm === 'AVB3') {
    if (action === 'transcutaneous_pacing') {
      return {
        nextRhythm: 'NSR',
        paced: true,
        converted: true,
        ahaViolationCode: null,
        rationale:
          'Transcutaneous pacing captures the ventricles below the infranodal His-Purkinje block and restores cardiac output.',
      };
    }
    if (action === 'atropine_1mg') {
      return {
        nextRhythm: 'AVB3',
        paced: false,
        converted: false,
        ahaViolationCode: 'AHA_AVB3_ATROPINE_INEFFECTIVE',
        rationale:
          'Atropine acts at the AV node and is ineffective in infranodal 3rd-degree complete heart block; initiate Transcutaneous Pacing immediately.',
      };
    }
  }

  // 5. SVT rescue
  if (currentRhythm === 'SVT' && (action === 'adenosine_6mg' || action === 'sync_cardioversion')) {
    return {
      nextRhythm: 'NSR',
      paced: false,
      converted: true,
      ahaViolationCode: null,
      rationale:
        action === 'adenosine_6mg'
          ? 'Adenosine 6 mg IV transiently blocks AV nodal re-entry and converts narrow-complex SVT to Normal Sinus Rhythm.'
          : 'Synchronized cardioversion terminates AV nodal re-entrant tachycardia.',
    };
  }

  // 6. Sinus Bradycardia rescue
  if (currentRhythm === 'SB' && (action === 'atropine_1mg' || action === 'transcutaneous_pacing')) {
    return {
      nextRhythm: 'NSR',
      paced: action === 'transcutaneous_pacing',
      converted: true,
      ahaViolationCode: null,
      rationale:
        action === 'atropine_1mg'
          ? 'Atropine 1 mg IV antagonizes vagal muscarinic tone at the SA node and restores sinus rate.'
          : 'Transcutaneous pacing captures bradycardic myocardium at 70 bpm.',
    };
  }

  // 7. AFib / AFlutter rescue
  if (
    (currentRhythm === 'AFIB' || currentRhythm === 'AFLT') &&
    (action === 'sync_cardioversion' || action === 'amiodarone_300mg')
  ) {
    return {
      nextRhythm: 'NSR',
      paced: false,
      converted: true,
      ahaViolationCode: null,
      rationale:
        'Rhythm/rate control restores organized atrioventricular synchrony and normalizes diastolic filling time.',
    };
  }

  // 8. Monomorphic VT rescue
  if (currentRhythm === 'VT_MONO') {
    if (
      (action === 'sync_cardioversion' || action === 'amiodarone_300mg') &&
      currentSbp >= 60
    ) {
      return {
        nextRhythm: 'NSR',
        paced: false,
        converted: true,
        ahaViolationCode: null,
        rationale:
          'Synchronized cardioversion / IV Amiodarone terminates monomorphic ventricular re-entry.',
      };
    }
    if (action === 'defibrillation') {
      return {
        nextRhythm: 'NSR',
        paced: false,
        converted: true,
        ahaViolationCode: null,
        rationale: 'High-energy defibrillation terminates unstable Ventricular Tachycardia.',
      };
    }
    if (action === 'adenosine_6mg') {
      return {
        nextRhythm: 'VFIB',
        paced: false,
        converted: false,
        ahaViolationCode: 'AHA_VT_ADENOSINE_DETERIORATION',
        rationale:
          'Calcium-channel / AV nodal vasodilators in unstable VT precipitate hemodynamic collapse.',
      };
    }
  }

  // 9. VFIB rescue
  if (currentRhythm === 'VFIB') {
    if (action === 'defibrillation') {
      return {
        nextRhythm: 'NSR',
        paced: false,
        converted: true,
        ahaViolationCode: null,
        rationale:
          'Immediate 200 J biphasic defibrillation achieves return of spontaneous circulation (ROSC).',
      };
    }
    return {
      nextRhythm: 'VFIB',
      paced: false,
      converted: false,
      ahaViolationCode: 'AHA_VFIB_DEFIB_REQUIRED',
      rationale:
        'Coarse Ventricular Fibrillation requires immediate unsynchronized defibrillation; pharmacotherapy alone cannot depolarize VF.',
    };
  }

  // 10. Asystole / PEA rescue
  if (currentRhythm === 'ASYSTOLE' || currentRhythm === 'PEA') {
    if (action === 'epinephrine_1mg') {
      return {
        nextRhythm: 'NSR',
        paced: false,
        converted: true,
        ahaViolationCode: null,
        rationale:
          'Epinephrine 1 mg IV alpha-1 vasoconstriction elevates coronary perfusion pressure above 15 mmHg and restores spontaneous circulation (ROSC).',
      };
    }
    return {
      nextRhythm: currentRhythm,
      paced: false,
      converted: false,
      ahaViolationCode: 'AHA_NONSHOCKABLE_EPI_REQUIRED',
      rationale:
        'Non-shockable arrest (Asystole / PEA) requires high-quality CPR and Epinephrine 1 mg IV.',
    };
  }

  // 11. Anterior STEMI stabilization
  if (currentRhythm === 'STEMI_ANT') {
    if (action === 'amiodarone_300mg') {
      return {
        nextRhythm: 'NSR',
        paced: false,
        converted: true,
        ahaViolationCode: null,
        rationale:
          'Prophylactic ischemic stabilization suppresses peri-infarct ventricular ectopy awaiting cath lab reperfusion.',
      };
    }
  }

  // Default mismatch
  return {
    nextRhythm: currentRhythm,
    paced: false,
    converted: false,
    ahaViolationCode: `AHA_MISMATCH_${currentRhythm}_${action.toUpperCase()}`,
    rationale: `${action} is not indicated for ${currentRhythm}; review the AHA ACLS algorithm.`,
  };
}

export function getAlarmPriorityForRhythm(rhythm: RhythmClass): AlarmPriority {
  return RHYTHM_PROFILES[rhythm].alarmPriority;
}

const DT_SEC = 0.05; // 20 Hz RK4 integration ticks

export function runSimulation(rawOptions: SimulationOptions): SimulationResult {
  const cfg = validateSimulationOptions(rawOptions);
  const rng = mulberry32(cfg.seed);

  const initialVitals = createInitialVitals(cfg.scenario);
  let activeRhythm: RhythmClass = cfg.scenario;
  let paced = false;
  let continuousState = {
    hr: initialVitals.hr,
    sbp: initialVitals.sbp,
    dbp: initialVitals.dbp,
    spo2: initialVitals.spo2,
    etco2: initialVitals.etco2,
    rr: initialVitals.rr,
  };

  const ahaViolations: string[] = [];
  const causalTimeline: CausalEvent[] = [
    {
      timeSec: 0,
      tick: 0,
      action: 'SCENARIO_START',
      preVitals: initialVitals,
      postVitals: initialVitals,
      converted: false,
      ahaViolationCode: null,
      rationale: `Telemetry monitor initialized in ${RHYTHM_PROFILES[cfg.scenario].label} (seed=${cfg.seed}).`,
    },
  ];

  const totalSteps = Math.round(cfg.durationSec / DT_SEC);
  const interventionStep =
    cfg.intervention !== null ? Math.max(1, Math.round(cfg.atSec / DT_SEC)) : -1;

  const trajectory: TrajectoryPoint[] = [
    {
      timeSec: 0,
      tick: 0,
      vitals: initialVitals,
    },
  ];

  let unrescuedSec = 0;

  for (let step = 1; step <= totalSteps; step++) {
    const timeSec = Number((step * DT_SEC).toFixed(2));

    if (step === interventionStep && cfg.intervention !== null) {
      const preVitals = clampPhysiology({
        rhythm: activeRhythm,
        ...continuousState,
        map: 0,
        paced,
      });
      const decision = evaluateAclsTransition(
        activeRhythm,
        cfg.intervention,
        preVitals.sbp
      );
      activeRhythm = decision.nextRhythm;
      paced = decision.paced;
      continuousState = applyTransitionToContinuousState(continuousState, decision);
      if (decision.converted) {
        unrescuedSec = 0;
      }
      if (decision.ahaViolationCode) {
        ahaViolations.push(decision.ahaViolationCode);
      }
      const postVitals = clampPhysiology({
        rhythm: activeRhythm,
        ...continuousState,
        map: 0,
        paced,
      });
      causalTimeline.push({
        timeSec: cfg.atSec === 0 ? 0 : timeSec,
        tick: cfg.atSec === 0 ? 0 : step,
        action: cfg.intervention,
        preVitals,
        postVitals,
        converted: decision.converted,
        ahaViolationCode: decision.ahaViolationCode,
        rationale: decision.rationale,
      });
    }

    if (activeRhythm !== 'NSR') {
      unrescuedSec += DT_SEC;
    }

    continuousState = stepHemodynamicsRk4(
      continuousState,
      activeRhythm,
      DT_SEC,
      unrescuedSec,
      rng,
      paced
    );

    // Emit 1 Hz trajectory snapshots (plus the final tick) to keep JSON concise while integrating at 20 Hz
    if (step % 20 === 0 || step === totalSteps) {
      trajectory.push({
        timeSec,
        tick: step,
        vitals: clampPhysiology({
          rhythm: activeRhythm,
          ...continuousState,
          map: 0,
          paced,
        }),
      });
    }
  }

  const finalVitals = trajectory[trajectory.length - 1]!.vitals;
  let outcome: 'STABILIZED' | 'DETERIORATED' | 'ARREST' = 'DETERIORATED';
  if (
    finalVitals.rhythm === 'VFIB' ||
    finalVitals.rhythm === 'ASYSTOLE' ||
    finalVitals.rhythm === 'PEA' ||
    finalVitals.sbp < 40
  ) {
    outcome = 'ARREST';
  } else if (finalVitals.rhythm === 'NSR' && finalVitals.sbp >= 95 && ahaViolations.length === 0) {
    outcome = 'STABILIZED';
  }

  return {
    seed: cfg.seed,
    scenario: cfg.scenario,
    intervention: cfg.intervention,
    interventionAtSec: cfg.intervention ? cfg.atSec : null,
    durationSec: cfg.durationSec,
    outcome,
    initialVitals,
    finalVitals,
    ahaViolations,
    causalTimeline,
    trajectory,
  };
}

export interface BedState {
  bedIndex: number;
  bedLabel: string;
  patientName: string;
  caseId: string;
  vitals: VitalState;
  alarmPriority: AlarmPriority;
  countdownSec: number;
  stabilized: boolean;
  arrested: boolean;
  lastInterventionMs: number;
  ahaViolations: string[];
  causalTimeline: CausalEvent[];
}

const BED_PATIENTS = [
  { bedLabel: 'Bed 01', patientName: 'E. Vance, 64F' },
  { bedLabel: 'Bed 02', patientName: 'M. Okafor, 58M' },
  { bedLabel: 'Bed 03', patientName: 'S. Lindqvist, 71F' },
  { bedLabel: 'Bed 04', patientName: 'R. Castellano, 49M' },
] as const;

const CRISIS_POOL: readonly RhythmClass[] = [
  'SVT',
  'TORSADES',
  'VFIB',
  'AVB3',
  'VT_MONO',
  'SB',
  'AFIB',
  'ASYSTOLE',
  'PEA',
  'STEMI_ANT',
];

export class ShiftController {
  private readonly seed: number;
  private readonly bedRngs: Array<() => number>;
  private readonly continuousStates: Array<{
    hr: number;
    sbp: number;
    dbp: number;
    spo2: number;
    etco2: number;
    rr: number;
  }>;
  private readonly beds: BedState[];
  private elapsedSec = 0;
  private tickCount = 0;
  private fractionalSec = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const masterRng = mulberry32(this.seed);
    this.bedRngs = [];
    this.continuousStates = [];
    this.beds = [];

    for (let i = 0; i < 4; i++) {
      const bedSeed = Math.floor(masterRng() * 0xffffffff) >>> 0;
      const bRng = mulberry32(bedSeed);
      this.bedRngs.push(bRng);

      const rhythmIdx = (Math.floor(bRng() * CRISIS_POOL.length) + i * 2) % CRISIS_POOL.length;
      const rhythm = CRISIS_POOL[rhythmIdx]!;
      const initVitals = createInitialVitals(rhythm);
      this.continuousStates.push({
        hr: initVitals.hr,
        sbp: initVitals.sbp,
        dbp: initVitals.dbp,
        spo2: initVitals.spo2,
        etco2: initVitals.etco2,
        rr: initVitals.rr,
      });

      const caseId = getCaseIdForRhythm(rhythm, i);
      const meta = BED_PATIENTS[i]!;

      this.beds.push({
        bedIndex: i,
        bedLabel: meta.bedLabel,
        patientName: meta.patientName,
        caseId,
        vitals: initVitals,
        alarmPriority: getAlarmPriorityForRhythm(rhythm),
        countdownSec: 60,
        stabilized: rhythm === 'NSR',
        arrested: false,
        lastInterventionMs: -1000,
        ahaViolations: [],
        causalTimeline: [
          {
            timeSec: 0,
            tick: 0,
            action: 'SCENARIO_START',
            preVitals: initVitals,
            postVitals: initVitals,
            converted: false,
            ahaViolationCode: null,
            rationale: `${meta.bedLabel} admitted in ${RHYTHM_PROFILES[rhythm].label}.`,
          },
        ],
      });
    }
  }

  public getSeed(): number {
    return this.seed;
  }

  public getElapsedSec(): number {
    return this.elapsedSec;
  }

  public getBeds(): readonly BedState[] {
    return this.beds;
  }

  public getHighestAlarmPriority(): AlarmPriority {
    let highest: AlarmPriority = 'NORMAL';
    for (const b of this.beds) {
      if (b.alarmPriority === 'CRISIS') return 'CRISIS';
      if (b.alarmPriority === 'WARNING') highest = 'WARNING';
    }
    return highest;
  }

  public stepSeconds(deltaSec: number): void {
    const clampedSec = Math.max(0, Math.min(10, deltaSec));
    this.fractionalSec += clampedSec;
    const steps = Math.floor((this.fractionalSec + 1e-9) / DT_SEC);
    this.fractionalSec = Math.max(0, this.fractionalSec - steps * DT_SEC);
    for (let s = 0; s < steps; s++) {
      this.tickCount += 1;
      this.elapsedSec = Number((this.tickCount * DT_SEC).toFixed(2));
      for (let i = 0; i < 4; i++) {
        const bed = this.beds[i]!;
        const cState = this.continuousStates[i]!;
        const rng = this.bedRngs[i]!;

        const nextState = stepHemodynamicsRk4(
          cState,
          bed.vitals.rhythm,
          DT_SEC,
          bed.stabilized ? 0 : this.elapsedSec,
          rng,
          bed.vitals.paced
        );
        this.continuousStates[i] = nextState;

        let expiredThisTick = false;
        const preArrestVitals = { ...bed.vitals };
        let nextRhythm = bed.vitals.rhythm;
        let nextPaced = bed.vitals.paced;

        if (!bed.stabilized && !bed.arrested) {
          bed.countdownSec = Math.max(0, Number((60 - this.elapsedSec).toFixed(1)));
          if (bed.countdownSec <= 0) {
            bed.arrested = true;
            bed.stabilized = false;
            nextRhythm = 'ASYSTOLE';
            nextPaced = false;
            bed.caseId = getCaseIdForRhythm('ASYSTOLE', bed.bedIndex);
            expiredThisTick = true;
          }
        }

        bed.vitals = clampPhysiology({
          rhythm: nextRhythm,
          ...nextState,
          map: 0,
          paced: nextPaced,
        });
        if (bed.vitals.sbp < 40 || bed.arrested) {
          bed.stabilized = false;
        }
        bed.alarmPriority =
          bed.ahaViolations.length > 0
            ? 'CRISIS'
            : getAlarmPriorityForRhythm(bed.vitals.rhythm);

        if (expiredThisTick) {
          bed.causalTimeline.push({
            timeSec: this.elapsedSec,
            tick: this.tickCount,
            action: 'ISCHEMIC_ARREST',
            preVitals: preArrestVitals,
            postVitals: { ...bed.vitals },
            converted: false,
            ahaViolationCode: null,
            rationale: `${bed.bedLabel} countdown expired without rescuing ACLS intervention; progressed to terminal ischemic Asystole.`,
          });
        }
      }
    }
  }

  public applyIntervention(
    bedIndex: number,
    action: AclsInterventionId,
    nowTimestampMs = Date.now()
  ): { applied: boolean; event: CausalEvent | null } {
    const bed = this.beds[bedIndex];
    if (!bed) {
      return { applied: false, event: null };
    }

    // Cooldown / idempotency guard against rapid accidental double-clicks (< 250 ms) (US-03.4)
    if (bed.lastInterventionMs >= 0 && nowTimestampMs - bed.lastInterventionMs < 250) {
      return { applied: false, event: null };
    }
    bed.lastInterventionMs = nowTimestampMs;

    const preVitals = { ...bed.vitals };
    const decision = evaluateAclsTransition(bed.vitals.rhythm, action, bed.vitals.sbp);
    const nextRhythm = decision.nextRhythm;
    const nextPaced = decision.paced;
    bed.caseId = getCaseIdForRhythm(nextRhythm, bed.bedIndex);
    this.continuousStates[bedIndex] = applyTransitionToContinuousState(
      this.continuousStates[bedIndex]!,
      decision
    );

    if (decision.converted) {
      bed.stabilized = true;
      bed.arrested = false;
    }

    if (decision.ahaViolationCode) {
      bed.ahaViolations.push(decision.ahaViolationCode);
      if (decision.nextRhythm === 'VFIB' || decision.nextRhythm === 'ASYSTOLE') {
        bed.arrested = true;
        bed.stabilized = false;
      }
    }

    bed.vitals = clampPhysiology({
      rhythm: nextRhythm,
      ...this.continuousStates[bedIndex]!,
      map: 0,
      paced: nextPaced,
    });
    if (bed.vitals.sbp < 40 || bed.arrested) {
      bed.stabilized = false;
    }
    bed.alarmPriority =
      bed.ahaViolations.length > 0
        ? 'CRISIS'
        : getAlarmPriorityForRhythm(bed.vitals.rhythm);

    const event: CausalEvent = {
      timeSec: this.elapsedSec,
      tick: this.tickCount,
      action,
      preVitals,
      postVitals: { ...bed.vitals },
      converted: decision.converted,
      ahaViolationCode: decision.ahaViolationCode,
      rationale: decision.rationale,
    };
    bed.causalTimeline.push(event);
    return { applied: true, event };
  }

  public computeShiftScore(): {
    scorePct: number;
    bedsStabilized: number;
    totalViolations: number;
  } {
    let bedsStabilized = 0;
    let totalViolations = 0;
    for (const b of this.beds) {
      if (b.vitals.rhythm === 'NSR') {
        bedsStabilized += 1;
      }
      totalViolations += b.ahaViolations.length;
    }
    const rawScore = bedsStabilized * 25 - totalViolations * 8;
    const scorePct = Math.max(0, Math.min(100, rawScore));
    return { scorePct, bedsStabilized, totalViolations };
  }
}
