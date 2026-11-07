import { useEffect, useRef } from 'preact/hooks';
import {
  ACLS_INTERVENTION_METADATA,
  type BedState,
} from '../../engine/aclsEngine.ts';
import { RHYTHM_PROFILES } from '../../engine/physiology.ts';
import type { AclsInterventionId } from '../../types/teleward.ts';
import {
  TelemetryRingBuffer,
  getSafe2dContext,
  renderTelemetryBedCanvas,
  stepTelemetryFrame,
} from '../canvas/TelemetryCanvas.ts';

export interface ShiftStationViewProps {
  stationTitle: string;
  stationSubtitle: string;
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

export function ShiftStationView(props: ShiftStationViewProps) {
  const {
    stationTitle,
    stationSubtitle,
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

  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([null, null, null, null]);
  const ringBuffersRef = useRef<TelemetryRingBuffer[] | null>(null);
  const lastResetKeyRef = useRef<string | undefined>(undefined);

  if (!ringBuffersRef.current || lastResetKeyRef.current !== shiftResetKey) {
    lastResetKeyRef.current = shiftResetKey;
    ringBuffersRef.current = beds.map((b) => {
      const rb = new TelemetryRingBuffer(2500, 90);
      rb.prefill(b.vitals, 1250);
      return rb;
    });
  }

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();
    let accumSimMs = 0;

    const tick = (now: number) => {
      const rawDelta = now - lastTime;
      lastTime = now;
      const clampedDelta = Math.max(0, Math.min(100, rawDelta));
      accumSimMs += clampedDelta;

      if (accumSimMs >= 250) {
        onStepSimulation(accumSimMs / 1000);
        accumSimMs = 0;
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
              renderTelemetryBedCanvas(
                ctx,
                canvas.width,
                canvas.height,
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

  const activeBed = beds[selectedBedIndex] ?? beds[0]!;

  return (
    <div class="flex flex-col gap-4">
      {/* Station Header */}
      <section class="tw-surface p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1>{stationTitle}</h1>
          <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
            {stationSubtitle}
          </p>
        </div>

        <div class="flex items-center gap-4">
          <div class="text-right">
            <div class="text-sm" style={{ color: 'var(--text-muted)' }}>
              Stabilized Beds
            </div>
            <div class="tw-mono-vital text-lg font-semibold">
              {scoreSummary.bedsStabilized} / 4 ({scoreSummary.scorePct}%)
            </div>
          </div>

          <button type="button" onClick={onResetShift} class="tw-btn-secondary">
            Reset 4-Bed Shift
          </button>
        </div>
      </section>

      {/* 2x2 60fps 2D Canvas ICU Bed Grid */}
      <section aria-label="4-Bed ICU Telemetry Monitors" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {beds.map((bed, idx) => {
          const isSelected = idx === selectedBedIndex;
          const alarmBg =
            bed.alarmPriority === 'CRISIS'
              ? 'var(--alarm-crisis-bg)'
              : bed.alarmPriority === 'WARNING'
                ? 'var(--alarm-warn-bg)'
                : 'var(--alarm-normal-bg)';
          const alarmText =
            bed.alarmPriority === 'CRISIS'
              ? 'var(--alarm-crisis-text)'
              : bed.alarmPriority === 'WARNING'
                ? 'var(--alarm-warn-text)'
                : 'var(--alarm-normal-text)';

          return (
            <div
              key={bed.bedIndex}
              data-testid={`bed-card-${idx}`}
              onClick={() => onSelectBed(idx)}
              class="tw-well p-3 flex flex-col gap-2 cursor-pointer"
              style={{
                borderColor: isSelected ? 'var(--primary)' : 'var(--border)',
                outline: isSelected ? '2px solid var(--primary)' : 'none',
              }}
            >
              {/* Bed Header Row */}
              <div class="flex items-center justify-between gap-2 pb-2 border-b" style={{ borderColor: 'var(--border)' }}>
                <div class="flex items-center gap-2">
                  <h2 class="m-0 text-base font-semibold" style={{ color: '#F1F5F9' }}>
                    {bed.bedLabel} · {bed.patientName}
                  </h2>
                  <span
                    data-testid={`bed-rhythm-${idx}`}
                    class="tw-mono-vital px-2 py-0.5 rounded text-sm font-semibold"
                    style={{ backgroundColor: alarmBg, color: alarmText }}
                  >
                    {bed.vitals.rhythm}
                  </span>
                </div>

                <div class="flex items-center gap-2">
                  <span class="tw-mono-vital text-sm" style={{ color: '#CBD5E1' }}>
                    {bed.stabilized ? 'ROSC / STABLE' : `T-${bed.countdownSec.toFixed(0)}s`}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenCaliperForCase(bed.caseId);
                    }}
                    class="tw-btn-secondary text-sm py-1 px-2"
                  >
                    12-Lead ({bed.caseId})
                  </button>
                </div>
              </div>

              {/* Canvas + Vital Readout Column */}
              <div class="grid grid-cols-[minmax(0,1fr)_128px] gap-3 items-center">
                <canvas
                  ref={(el) => {
                    canvasRefs.current[idx] = el;
                  }}
                  width={460}
                  height={168}
                  class="w-full h-42 rounded"
                  aria-label={`${bed.bedLabel} 500 Hz ECG, ABP, SpO2, and EtCO2 waveform monitor`}
                />

                <dl class="m-0 grid grid-cols-1 gap-1.5 text-right">
                  <div>
                    <dt class="text-sm" style={{ color: '#94A3B8' }}>
                      HR (bpm)
                    </dt>
                    <dd class="m-0 tw-mono-vital text-2xl font-semibold" style={{ color: 'var(--trace-ecg)' }}>
                      {bed.vitals.hr}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-sm" style={{ color: '#94A3B8' }}>
                      ABP (mmHg)
                    </dt>
                    <dd class="m-0 tw-mono-vital text-base font-semibold" style={{ color: 'var(--trace-abp)' }}>
                      {bed.vitals.sbp}/{bed.vitals.dbp} ({bed.vitals.map})
                    </dd>
                  </div>
                  <div class="flex justify-between gap-2">
                    <div>
                      <dt class="text-sm" style={{ color: '#94A3B8' }}>
                        SpO2
                      </dt>
                      <dd class="m-0 tw-mono-vital text-base font-semibold" style={{ color: 'var(--trace-spo2)' }}>
                        {bed.vitals.spo2}%
                      </dd>
                    </div>
                    <div>
                      <dt class="text-sm" style={{ color: '#94A3B8' }}>
                        EtCO2
                      </dt>
                      <dd class="m-0 tw-mono-vital text-base font-semibold" style={{ color: 'var(--trace-etco2)' }}>
                        {bed.vitals.etco2}
                      </dd>
                    </div>
                  </div>
                </dl>
              </div>
            </div>
          );
        })}
      </section>

      {/* ACLS Crash Cart Dock with Acting-As Target Bed Guard */}
      <section aria-label="ACLS Crash Cart Interventions" class="tw-surface p-4 flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-2" style={{ borderColor: 'var(--border)' }}>
          <h2 class="m-0">ACLS Crash Cart Resuscitation Dock</h2>
          <span
            data-testid="acting-as-bed-guard"
            class="px-3 py-1 rounded text-sm font-semibold"
            style={{ backgroundColor: 'var(--surface-muted)', color: 'var(--text)' }}
          >
            Administer to {activeBed.bedLabel} ({activeBed.vitals.rhythm} — {RHYTHM_PROFILES[activeBed.vitals.rhythm].label})
          </span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {ACLS_INTERVENTION_METADATA.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`crash-cart-btn-${item.id}`}
              onClick={() => onApplyIntervention(activeBed.bedIndex, item.id)}
              class="tw-btn-secondary text-left flex flex-col justify-between p-3"
            >
              <span class="font-semibold text-sm">{item.label}</span>
              <span class="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                {item.indicationHint}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
