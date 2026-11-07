import { useState } from 'preact/hooks';
import type { BedState } from '../../engine/aclsEngine.ts';
import { getUtcDateKey } from '../../engine/prng.ts';
import type { AclsInterventionId } from '../../types/teleward.ts';
import { ShiftStationView } from './ShiftStationView.tsx';

export interface DailyChallengeViewProps {
  beds: readonly BedState[];
  selectedBedIndex: number;
  onSelectBed: (index: number) => void;
  onApplyIntervention: (bedIndex: number, action: AclsInterventionId) => void;
  onResetShift: () => void;
  onStepSimulation: (deltaSec: number) => void;
  onOpenCaliperForCase: (caseId: string) => void;
  scoreSummary: { scorePct: number; bedsStabilized: number; totalViolations: number };
}

export function DailyChallengeView(props: DailyChallengeViewProps) {
  const utcDateKey = getUtcDateKey();
  const [dailyReceipt, setDailyReceipt] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const handleFinishDaily = () => {
    const receiptCode = `TW-DAILY-${utcDateKey}-${props.scoreSummary.scorePct}-${props.scoreSummary.bedsStabilized}B`;
    setDailyReceipt(receiptCode);
    try {
      window.localStorage.setItem(
        'teleward_daily_v1',
        JSON.stringify({
          date: utcDateKey,
          scorePct: props.scoreSummary.scorePct,
          bedsStabilized: props.scoreSummary.bedsStabilized,
          receiptCode,
        })
      );
      setStorageWarning(null);
    } catch {
      // Graceful fallback when localStorage throws QuotaExceededError (US-03.5)
      setStorageWarning(
        'Browser storage quota reached; daily receipt remains available in memory for copying.'
      );
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <section class="tw-surface p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1>Daily UTC 60-Second Code Challenge ({utcDateKey})</h1>
          <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
            Every clinician worldwide receives the identical UTC-seeded 4-bed ICU dysrhythmia sequence today.
          </p>
        </div>

        <div class="flex items-center gap-3">
          {dailyReceipt ? (
            <div class="px-3 py-2 rounded border text-sm" style={{ borderColor: 'var(--border)' }}>
              <span>Shareable Receipt: </span>
              <strong class="tw-mono-vital">{dailyReceipt}</strong>
            </div>
          ) : null}

          <button
            type="button"
            data-testid="finish-daily-shift-btn"
            onClick={handleFinishDaily}
            class="tw-btn-primary"
          >
            Generate Daily Score Receipt
          </button>
        </div>
      </section>

      {storageWarning ? (
        <div class="tw-surface p-3 text-sm" role="status">
          {storageWarning}
        </div>
      ) : null}

      <ShiftStationView
        stationTitle={`UTC Daily Telemetry Shift · ${utcDateKey}`}
        stationSubtitle="Stabilize all 4 ICU beds with zero AHA rule violations to earn a 100% daily verification code."
        {...props}
      />
    </div>
  );
}
