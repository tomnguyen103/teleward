export const RHYTHM_CLASSES = [
  'NSR',
  'SB',
  'SVT',
  'AFIB',
  'AFLT',
  'AVB3',
  'VT_MONO',
  'TORSADES',
  'VFIB',
  'ASYSTOLE',
  'PEA',
  'STEMI_ANT',
] as const;

export type RhythmClass = (typeof RHYTHM_CLASSES)[number];

export const LEAD_NAMES = [
  'I',
  'II',
  'III',
  'aVR',
  'aVL',
  'aVF',
  'V1',
  'V2',
  'V3',
  'V4',
  'V5',
  'V6',
] as const;

export type LeadName = (typeof LEAD_NAMES)[number];

export const ACLS_INTERVENTIONS = [
  'adenosine_6mg',
  'amiodarone_300mg',
  'epinephrine_1mg',
  'atropine_1mg',
  'magnesium_2g',
  'sync_cardioversion',
  'defibrillation',
  'transcutaneous_pacing',
] as const;

export type AclsInterventionId = (typeof ACLS_INTERVENTIONS)[number];

export type AlarmPriority = 'NORMAL' | 'WARNING' | 'CRISIS';

export interface FiducialGroundTruth {
  hrBpm: number;
  prMs: number;
  qrsMs: number;
  qtMs: number;
  qtcMs: number;
  stMv: number;
  pOnSample: number;
  qrsOnSample: number;
  rPeakSamples: number[];
  qrsOffSample: number;
  tOffSample: number;
  jPointSample: number;
}

export interface PtbxlCaseRecord {
  caseId: string;
  recordIndex: number;
  ptbxlRecordId: number;
  rhythmClass: RhythmClass;
  scpCodes: string[];
  clinicalSummary: string;
  age: number;
  sex: 'F' | 'M';
  freeStarter: boolean;
  fiducials: FiducialGroundTruth;
}

export interface PtbxlIndexManifest {
  magic: 'TWEC';
  version: number;
  recordCount: number;
  leadCount: number;
  sampleRateHz: number;
  samplesPerLeadTile: number;
  binaryByteLength: number;
  crc32Hex: string;
  sha256Hex: string;
  records: PtbxlCaseRecord[];
}

export interface VitalState {
  rhythm: RhythmClass;
  hr: number;
  sbp: number;
  dbp: number;
  map: number;
  spo2: number;
  etco2: number;
  rr: number;
  paced: boolean;
}

export interface CausalEvent {
  timeSec: number;
  tick: number;
  action: AclsInterventionId | 'SCENARIO_START' | 'ISCHEMIC_ARREST';
  preVitals: VitalState;
  postVitals: VitalState;
  converted: boolean;
  ahaViolationCode: string | null;
  rationale: string;
}

export interface SimulationOptions {
  scenario: RhythmClass | string;
  intervention?: AclsInterventionId | string | null;
  atSec?: number;
  durationSec?: number;
  seed: number;
}

export interface TrajectoryPoint {
  timeSec: number;
  tick: number;
  vitals: VitalState;
}

export interface SimulationResult {
  seed: number;
  scenario: RhythmClass;
  intervention: AclsInterventionId | null;
  interventionAtSec: number | null;
  durationSec: number;
  outcome: 'STABILIZED' | 'DETERIORATED' | 'ARREST';
  initialVitals: VitalState;
  finalVitals: VitalState;
  ahaViolations: string[];
  causalTimeline: CausalEvent[];
  trajectory: TrajectoryPoint[];
}

export interface Rfc7807Error {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
}
