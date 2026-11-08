import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ACLS_INTERVENTION_METADATA,
  type BedState,
  type InterventionMetadata,
} from '../../engine/aclsEngine.ts';
import { RHYTHM_PROFILES } from '../../engine/physiology.ts';
import type { AclsInterventionId } from '../../types/teleward.ts';
import {
  TelemetryRingBuffer,
  getSafe2dContext,
  renderTelemetryBedCanvas,
  stepTelemetryFrame,
  syncCanvasHiDpi,
} from '../canvas/TelemetryCanvas.ts';

export interface ShiftStationViewProps {
  stationTitle: string;
  stationSubtitle?: string;
  hideStationHeader?: boolean;
  disableHotkeys?: boolean;
  beds: readonly BedState[];
  selectedBedIndex: number;
  onSelectBed: (index: number) => void;
  onApplyIntervention: (bedIndex: number, action: AclsInterventionId) => void;
  onResetShift: () => void;
  onStepSimulation: (deltaSec: number) => void;
  onOpenCaliperForCase: (caseId: string) => void;
  scoreSummary: { scorePct: number; bedsStabilized: number; totalViolations: number };
  shiftResetKey?: string;
}

const ELECTRICAL_BAY_IDS: readonly AclsInterventionId[] = [
  'sync_cardioversion',
  'defibrillation',
  'transcutaneous_pacing',
];

const PHARMACOLOGY_RACK_IDS: readonly AclsInterventionId[] = [
  'adenosine_6mg',
  'amiodarone_300mg',
  'epinephrine_1mg',
  'atropine_1mg',
  'magnesium_2g',
];

const HOTKEY_ORDER: readonly AclsInterventionId[] = [
  ...ELECTRICAL_BAY_IDS,
  ...PHARMACOLOGY_RACK_IDS,
];

const ISO_26825_DRUG_BADGES: Record<
  AclsInterventionId,
  { shortTitle: string; tag: string; briefHint: string; bg: string; fg: string; hotkey: number }
> = {
  sync_cardioversion: {
    shortTitle: 'Cardioversion',
    tag: '100J',
    briefHint: 'Unstable SVT, AFib, AFlutter, or pulsed VT',
    bg: '#3B2106',
    fg: '#FDE68A',
    hotkey: 1,
  },
  defibrillation: {
    shortTitle: 'Defibrillation',
    tag: '200J',
    briefHint: 'Pulseless VF, Pulseless VT, or Torsades',
    bg: '#3B0A11',
    fg: '#FECDD3',
    hotkey: 2,
  },
  transcutaneous_pacing: {
    shortTitle: 'Pacer (TCP)',
    tag: '70ppm',
    briefHint: '3rd-Degree AV Block or refractory Bradycardia',
    bg: '#052E1C',
    fg: '#A7F3D0',
    hotkey: 3,
  },
  adenosine_6mg: {
    shortTitle: 'Adenosine',
    tag: '6mg',
    briefHint: 'Regular narrow-complex SVT (AVNRT)',
    bg: '#1E293B',
    fg: '#BAE6FD',
    hotkey: 4,
  },
  amiodarone_300mg: {
    shortTitle: 'Amiodarone',
    tag: '300mg',
    briefHint: 'Shock-refractory VF/pVT or stable VT',
    bg: '#3B0A11',
    fg: '#FCA5A5',
    hotkey: 5,
  },
  epinephrine_1mg: {
    shortTitle: 'Epinephrine',
    tag: '1mg',
    briefHint: 'Non-shockable Asystole / PEA arrest',
    bg: '#2E1065',
    fg: '#E9D5FF',
    hotkey: 6,
  },
  atropine_1mg: {
    shortTitle: 'Atropine',
    tag: '1mg',
    briefHint: 'Symptomatic Sinus Bradycardia',
    bg: '#052E1C',
    fg: '#86EFAC',
    hotkey: 7,
  },
  magnesium_2g: {
    shortTitle: 'Magnesium',
    tag: '2g',
    briefHint: 'Polymorphic VT (Torsades de Pointes)',
    bg: '#3B2106',
    fg: '#FDE68A',
    hotkey: 8,
  },
};

function getMetadataById(id: AclsInterventionId): InterventionMetadata {
  return (
    ACLS_INTERVENTION_METADATA.find((m) => m.id === id) ?? ACLS_INTERVENTION_METADATA[0]!
  );
}

export function ShiftStationView(props: ShiftStationViewProps) {
  const {
    stationTitle,
    hideStationHeader = false,
    disableHotkeys = false,
    beds,
    selectedBedIndex,
    onSelectBed,
    onApplyIntervention,
    onResetShift,
    onStepSimulation,
    onOpenCaliperForCase,
    scoreSummary,
    shiftResetKey,
  } = props;

  const [activeDockBay, setActiveDockBay] = useState<'all' | 'electrical' | 'pharmacology'>('all');
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([null, null, null, null]);
  const ringBuffersRef = useRef<TelemetryRingBuffer[] | null>(null);
  const lastResetKeyRef = useRef<string | undefined>(undefined);
  const accumSimMsRef = useRef(0);

  if (!ringBuffersRef.current || lastResetKeyRef.current !== shiftResetKey) {
    lastResetKeyRef.current = shiftResetKey;
    accumSimMsRef.current = 0;
    ringBuffersRef.current = beds.map((b) => {
      const rb = new TelemetryRingBuffer(2500, 90);
      rb.prefill(b.vitals, 1250);
      return rb;
    });
  }

  const activeBed = beds[selectedBedIndex] ?? beds[0]!;

  useEffect(() => {
    if (typeof window === 'undefined' || disableHotkeys) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase() ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      const num = Number(e.key);
      if (Number.isInteger(num) && num >= 1 && num <= 8) {
        const actionId = HOTKEY_ORDER[num - 1];
        if (actionId) {
          e.preventDefault();
          onApplyIntervention(activeBed.bedIndex, actionId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeBed.bedIndex, disableHotkeys, onApplyIntervention]);

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const rawDelta = now - lastTime;
      lastTime = now;
      const clampedDelta = Math.max(0, Math.min(100, rawDelta));
      accumSimMsRef.current += clampedDelta;

      if (accumSimMsRef.current >= 250) {
        const dtSec = accumSimMsRef.current / 1000;
        accumSimMsRef.current = 0;
        onStepSimulation(dtSec);
      }

      const rings = ringBuffersRef.current;
      if (rings) {
        for (let i = 0; i < 4; i++) {
          const bed = beds[i];
          const rb = rings[i];
          const canvas = canvasRefs.current[i];
          if (bed && rb && canvas) {
            stepTelemetryFrame(rb, bed.vitals, clampedDelta);
            const ctx = getSafe2dContext(canvas);
            if (ctx) {
              const { width, height } = syncCanvasHiDpi(canvas, 460, 152, ctx, true);
              renderTelemetryBedCanvas(
                ctx,
                width,
                height,
                rb,
                i === selectedBedIndex
              );
            }
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [beds, selectedBedIndex, onStepSimulation]);

  return (
    <div class="flex flex-col gap-3">
      {/* Group 1: Station Command Bar */}
      <section class="tw-surface px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          {!hideStationHeader ? (
            <h1 class="m-0">{stationTitle}</h1>
          ) : (
            <span class="text-sm font-semibold tw-text-muted">Live Ward Telemetry</span>
          )}
        </div>

        <div class="flex flex-wrap items-center gap-4">
          <div class="hidden xl:flex items-center gap-2.5 text-xs tw-mono-vital px-2.5 py-1 rounded tw-chip-muted">
            <span class="tw-text-ecg">II 1.0mV</span>
            <span class="tw-text-abp">ART mmHg</span>
            <span class="tw-text-spo2">PLETH</span>
            <span class="tw-text-etco2">CO2 mmHg</span>
            <span class="tw-text-muted">25 mm/s</span>
          </div>

          <div class="text-right">
            <div class="text-xs tw-text-muted">Stabilized Beds</div>
            <div class="tw-mono-vital text-base font-semibold">
              {scoreSummary.bedsStabilized} / 4 ({scoreSummary.scorePct}%)
            </div>
          </div>

          <button type="button" onClick={onResetShift} class="tw-btn-secondary">
            Reset Shift
          </button>
        </div>
      </section>

      {/* Group 2: 2x2 HiDPI 60fps 2D Canvas ICU Bedside Monitor Matrix */}
      <section aria-label="4-Bed ICU Telemetry Monitors" class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {beds.map((bed, idx) => {
          const isSelected = idx === selectedBedIndex;
          const alarmBadgeClass =
            bed.alarmPriority === 'CRISIS'
              ? 'tw-beacon-crisis'
              : bed.alarmPriority === 'WARNING'
                ? 'tw-beacon-warning'
                : 'tw-beacon-normal';

          return (
            <div
              key={bed.bedIndex}
              data-testid={`bed-card-${idx}`}
              onClick={() => onSelectBed(idx)}
              class={`tw-well p-2.5 flex flex-col gap-2 cursor-pointer ${
                isSelected ? 'ring-2 ring-emerald-500' : ''
              }`}
            >
              {/* Bed Header Row */}
              <div class="flex items-center justify-between gap-2 pb-1.5 border-b tw-border">
                <div class="flex items-center gap-2">
                  <h2 class="m-0 text-base font-semibold">
                    {bed.bedLabel} · {bed.patientName}
                  </h2>
                  <span
                    data-testid={`bed-rhythm-${idx}`}
                    class={`tw-mono-vital px-2 py-1 rounded text-xs font-semibold ${alarmBadgeClass}`}
                  >
                    {bed.vitals.rhythm}
                  </span>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  <span class="tw-mono-vital text-sm font-semibold whitespace-nowrap tw-text-muted">
                    {bed.stabilized
                      ? 'ROSC / STABLE'
                      : bed.arrested
                        ? 'ARRESTED'
                        : `T-${bed.countdownSec.toFixed(0)}s`}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenCaliperForCase(bed.caseId);
                    }}
                    class="tw-btn-secondary text-xs py-1.5 px-2.5 whitespace-nowrap"
                  >
                    Calipers <span class="hidden 2xl:inline">({bed.caseId})</span>
                  </button>
                </div>
              </div>

              {/* Canvas + Right-Hand Bedside Parameter Readout Column */}
              <div class="grid grid-cols-[minmax(0,1fr)_116px] 2xl:grid-cols-[minmax(0,1fr)_140px] gap-2.5 items-center">
                <canvas
                  ref={(el) => {
                    canvasRefs.current[idx] = el;
                  }}
                  width={460}
                  height={152}
                  class="w-full h-38 rounded"
                  aria-label={`${bed.bedLabel} 500 Hz ECG (II 1.0mV), ABP (ART mmHg), SpO2 (PLETH), and EtCO2 (CO2 mmHg) waveform monitor`}
                />

                <dl class="m-0 grid grid-cols-1 gap-1 text-right">
                  <div>
                    <dt class="text-xs tw-text-muted">HR (bpm)</dt>
                    <dd class="m-0 tw-mono-vital text-2xl font-semibold tw-text-ecg">
                      {bed.vitals.hr}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-xs tw-text-muted">ABP (mmHg)</dt>
                    <dd class="m-0 tw-mono-vital text-sm font-semibold tw-text-abp">
                      {bed.vitals.sbp}/{bed.vitals.dbp} ({bed.vitals.map})
                    </dd>
                  </div>
                  <div class="flex justify-between gap-2">
                    <div>
                      <dt class="text-xs tw-text-muted">SpO2</dt>
                      <dd class="m-0 tw-mono-vital text-sm font-semibold tw-text-spo2">
                        {bed.vitals.spo2}%
                      </dd>
                    </div>
                    <div>
                      <dt class="text-xs tw-text-muted">EtCO2</dt>
                      <dd class="m-0 tw-mono-vital text-sm font-semibold tw-text-etco2">
                        {bed.vitals.etco2}
                      </dd>
                    </div>
                    <div>
                      <dt class="text-xs tw-text-muted">RR</dt>
                      <dd class="m-0 tw-mono-vital text-sm font-semibold">
                        {bed.vitals.rr}
                      </dd>
                    </div>
                  </div>
                </dl>
              </div>
            </div>
          );
        })}
      </section>

      {/* Group 3: Segmented 2-Bay ACLS Crash Cart Dock */}
      <section aria-label="ACLS Crash Cart Interventions" class="tw-surface divide-y tw-border">
        <div class="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="m-0">ACLS Crash Cart</h2>
            <div class="tw-seg-group" role="group" aria-label="Crash Cart Bay Filter">
              <button
                type="button"
                onClick={() => setActiveDockBay('all')}
                class={activeDockBay === 'all' ? 'tw-seg-btn-active' : 'tw-seg-btn'}
              >
                All Bays
              </button>
              <button
                type="button"
                onClick={() => setActiveDockBay('electrical')}
                class={activeDockBay === 'electrical' ? 'tw-seg-btn-active' : 'tw-seg-btn'}
              >
                Electrical Therapy
              </button>
              <button
                type="button"
                onClick={() => setActiveDockBay('pharmacology')}
                class={activeDockBay === 'pharmacology' ? 'tw-seg-btn-active' : 'tw-seg-btn'}
              >
                IV Bolus Rack
              </button>
            </div>
          </div>

          <span
            data-testid="acting-as-bed-guard"
            class="px-3 py-1.5 rounded text-sm font-semibold tw-chip-muted"
          >
            Target: {activeBed.bedLabel} ({activeBed.vitals.rhythm} · {RHYTHM_PROFILES[activeBed.vitals.rhythm].label})
          </span>
        </div>

        <div class="grid grid-cols-1 2xl:grid-cols-12 divide-y 2xl:divide-y-0 2xl:divide-x tw-border">
          {/* Bay 1: Electrical Therapy Bay */}
          <div
            class={`${
              activeDockBay === 'pharmacology' ? 'hidden' : 'flex'
            } ${activeDockBay === 'electrical' ? '2xl:col-span-12' : '2xl:col-span-5'} p-3 flex-col gap-2`}
          >
            <div class="flex items-center justify-between">
              <h3 class="m-0 text-sm font-semibold">Electrical Therapy Bay (Biphasic Defibrillator / Pacer)</h3>
              <span class="tw-mono-vital text-xs tw-text-muted">Hotkeys 1–3</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {ELECTRICAL_BAY_IDS.map((id) => {
                const item = getMetadataById(id);
                const badge = ISO_26825_DRUG_BADGES[id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`crash-cart-btn-${item.id}`}
                    onClick={() => onApplyIntervention(activeBed.bedIndex, item.id)}
                    class="tw-btn-secondary text-left flex flex-col justify-between p-2.5 gap-1"
                  >
                    <div class="w-full flex flex-wrap items-center justify-between gap-1">
                      <span class="font-semibold text-sm">{badge.shortTitle}</span>
                      <span
                        class="tw-mono-vital px-1.5 py-0.5 rounded text-xs font-semibold shrink-0"
                        style={{ backgroundColor: badge.bg, color: badge.fg }}
                      >
                        {badge.tag}
                      </span>
                    </div>
                    <div class="w-full flex items-end justify-between gap-1.5">
                      <span class="text-xs leading-snug tw-text-muted">{badge.briefHint}</span>
                      <kbd class="tw-mono-vital text-xs shrink-0 tw-text-muted">
                        [{badge.hotkey}]
                      </kbd>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bay 2: ISO-26825 IV Pharmacology Bolus Rack */}
          <div
            class={`${
              activeDockBay === 'electrical' ? 'hidden' : 'flex'
            } ${activeDockBay === 'pharmacology' ? '2xl:col-span-12' : '2xl:col-span-7'} p-3 flex-col gap-2`}
          >
            <div class="flex items-center justify-between">
              <h3 class="m-0 text-sm font-semibold">ISO-26825 IV Pharmacology Bolus Rack</h3>
              <span class="tw-mono-vital text-xs tw-text-muted">Hotkeys 4–8</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-2">
              {PHARMACOLOGY_RACK_IDS.map((id) => {
                const item = getMetadataById(id);
                const badge = ISO_26825_DRUG_BADGES[id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`crash-cart-btn-${item.id}`}
                    onClick={() => onApplyIntervention(activeBed.bedIndex, item.id)}
                    class="tw-btn-secondary text-left flex flex-col justify-between p-2.5 gap-1"
                  >
                    <div class="w-full flex flex-wrap items-center justify-between gap-1">
                      <span class="font-semibold text-sm">{badge.shortTitle}</span>
                      <span
                        class="tw-mono-vital px-1.5 py-0.5 rounded text-xs font-semibold shrink-0"
                        style={{ backgroundColor: badge.bg, color: badge.fg }}
                      >
                        {badge.tag}
                      </span>
                    </div>
                    <div class="w-full flex items-end justify-between gap-1.5">
                      <span class="text-xs leading-snug tw-text-muted">{badge.briefHint}</span>
                      <kbd class="tw-mono-vital text-xs shrink-0 tw-text-muted">
                        [{badge.hotkey}]
                      </kbd>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
