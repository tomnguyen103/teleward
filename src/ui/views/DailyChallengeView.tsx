import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDailyReceipt } from '../../billing/cohortAndEntitlement.ts';
import type { BedState } from '../../engine/aclsEngine.ts';
import { getUtcDateKey } from '../../engine/prng.ts';
import type { AclsInterventionId } from '../../types/teleward.ts';
import {
  fetchDailyChallenge,
  getFallbackDailyLeaderboard,
  submitDailyChallenge,
  type DailyLeaderboardEntry,
} from '../apiClient.ts';
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
  shiftResetKey?: string;
}

export function DailyChallengeView(props: DailyChallengeViewProps) {
  const utcDateKey = getUtcDateKey();
  const [clinicianAlias, setClinicianAlias] = useState('ICU Operator');
  const [dailyReceipt, setDailyReceipt] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage?.getItem('teleward_daily_v1');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { date?: string; receiptCode?: string };
      if (parsed.date === utcDateKey && typeof parsed.receiptCode === 'string') {
        return parsed.receiptCode;
      }
      return null;
    } catch {
      return null;
    }
  });
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<DailyLeaderboardEntry[]>(() =>
    getFallbackDailyLeaderboard(utcDateKey)
  );
  const dailyReqSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++dailyReqSeqRef.current;
    void fetchDailyChallenge().then((res) => {
      if (dailyReqSeqRef.current === seq && res.leaderboard.length > 0) {
        setLeaderboard(res.leaderboard);
      }
    });
    return () => {
      dailyReqSeqRef.current++;
    };
  }, [utcDateKey]);

  const handleFinishDaily = () => {
    const receiptCode = formatDailyReceipt(
      utcDateKey,
      props.scoreSummary.scorePct,
      props.scoreSummary.bedsStabilized
    );
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

    const seq = ++dailyReqSeqRef.current;
    void submitDailyChallenge({
      clinicianAlias: clinicianAlias.trim() || 'ICU Operator',
      scorePct: props.scoreSummary.scorePct,
      bedsStabilized: props.scoreSummary.bedsStabilized,
      violations: props.scoreSummary.totalViolations,
    }).then((res) => {
      if (dailyReqSeqRef.current === seq) {
        setLeaderboard(res.leaderboard);
      }
    });
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

        <div class="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="daily-clinician-alias" class="sr-only">
              Clinician Callsign
            </label>
            <input
              id="daily-clinician-alias"
              name="clinicianAlias"
              data-testid="daily-clinician-alias-input"
              type="text"
              autocomplete="off"
              value={clinicianAlias}
              onInput={(e) => setClinicianAlias((e.target as HTMLInputElement).value)}
              placeholder="Callsign (e.g. R. Patel, RN)"
              class="h-10 px-3 rounded border text-sm"
              style={{
                backgroundColor: 'var(--surface-muted)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>

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

      {/* Live Daily Challenge Leaderboard */}
      <section class="tw-surface p-4 flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 class="m-0">UTC Daily Resuscitation Leaderboard ({utcDateKey})</h2>
          <span class="tw-mono-vital text-xs" style={{ color: 'var(--text-muted)' }}>
            {leaderboard.length} Verified Runs
          </span>
        </div>

        <div class="overflow-x-auto">
          <table
            data-testid="daily-leaderboard-table"
            class="w-full text-left border-collapse text-sm"
          >
            <thead>
              <tr class="border-b" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                <th class="py-2 pr-3 font-medium">Rank</th>
                <th class="py-2 pr-3 font-medium">Clinician Callsign</th>
                <th class="py-2 pr-3 font-medium">Score</th>
                <th class="py-2 pr-3 font-medium">Stabilized Beds</th>
                <th class="py-2 pr-3 font-medium">AHA Violations</th>
                <th class="py-2 font-medium">Daily Receipt</th>
              </tr>
            </thead>
            <tbody class="divide-y" style={{ borderColor: 'var(--border)' }}>
              {leaderboard.map((row, idx) => (
                <tr key={`${row.receipt}-${idx}`}>
                  <td class="py-2 pr-3 tw-mono-vital">#{row.rank ?? idx + 1}</td>
                  <td class="py-2 pr-3 font-medium">{row.clinicianAlias}</td>
                  <td class="py-2 pr-3 tw-mono-vital font-semibold" style={{ color: 'var(--trace-ecg)' }}>
                    {row.scorePct}%
                  </td>
                  <td class="py-2 pr-3 tw-mono-vital">{row.bedsStabilized} / 4</td>
                  <td class="py-2 pr-3 tw-mono-vital">{row.violations}</td>
                  <td class="py-2 tw-mono-vital text-xs" style={{ color: 'var(--text-muted)' }}>
                    {row.receipt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
