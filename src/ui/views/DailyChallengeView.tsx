import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDailyReceipt } from '../../billing/cohortAndEntitlement.ts';
import { getDailySeed, getUtcDateKey } from '../../engine/prng.ts';
import {
  fetchDailyChallenge,
  getFallbackDailyLeaderboard,
  submitDailyChallenge,
  type DailyLeaderboardEntry,
} from '../apiClient.ts';

export interface DailyChallengeViewProps {
  scoreSummary: { scorePct: number; bedsStabilized: number; totalViolations: number };
  interventionsLog?: Array<{ bedIndex: number; action: string; atSec?: number }>;
  elapsedSec?: number;
  onLaunchDailyShift?: () => void;
}

/**
 * Renders the UTC-seeded Daily Shift Seed view with a 3-group layout: Briefing Strip, 4-Column Daily Standings, and CRC16 Receipt Strip.
 */
export function DailyChallengeView(props: DailyChallengeViewProps) {
  const utcDateKey = getUtcDateKey();
  const dailySeedNum = getDailySeed();
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
      setStorageWarning('Browser storage is full. Copy the CRC16 receipt below.');
    }

    const seq = ++dailyReqSeqRef.current;
    void submitDailyChallenge({
      clinicianAlias: clinicianAlias.trim() || 'ICU Operator',
      scorePct: props.scoreSummary.scorePct,
      bedsStabilized: props.scoreSummary.bedsStabilized,
      violations: props.scoreSummary.totalViolations,
      ...(props.interventionsLog !== undefined ? { interventions: props.interventionsLog } : {}),
      ...(props.elapsedSec !== undefined ? { elapsedSec: props.elapsedSec } : {}),
    }).then((res) => {
      if (dailyReqSeqRef.current === seq) {
        setLeaderboard(res.leaderboard);
        if (!res.online) {
          setStorageWarning('API server is offline. Local storage holds this score.');
        }
      }
    });
  };

  return (
    <div class="flex flex-col gap-4 max-w-5xl mx-auto w-full">
      {/* Group 1: UTC Daily Shift Seed Briefing Strip */}
      <section class="tw-surface px-4 py-3 flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="m-0">Daily Shift Seed</h1>
          <span class="tw-mono-vital text-xs px-2 py-1 rounded tw-chip-muted">
            UTC {utcDateKey} · Seed {dailySeedNum}
          </span>
          <span class="tw-mono-vital text-xs px-2 py-1 rounded tw-chip-muted">
            {props.scoreSummary.bedsStabilized} / 4 Beds ({props.scoreSummary.scorePct}%)
          </span>
        </div>

        <button
          type="button"
          data-testid="launch-daily-shift-btn"
          onClick={() => props.onLaunchDailyShift?.()}
          class="tw-btn-primary"
        >
          Run Daily Shift
        </button>
      </section>

      {storageWarning ? (
        <div class="tw-surface p-3 text-sm" role="status">
          {storageWarning}
        </div>
      ) : null}

      {/* Group 2: 4-Column Daily Standings Table */}
      <section class="flex tw-surface p-4 flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b tw-border">
          <h2 class="m-0">Daily Standings</h2>
          <span class="tw-mono-vital text-xs tw-text-muted">
            {leaderboard.length} Daily Entries ({utcDateKey})
          </span>
        </div>

        <div class="overflow-x-auto">
          <table
            data-testid="daily-leaderboard-table"
            class="w-full text-left border-collapse text-sm"
          >
            <thead>
              <tr class="border-b tw-border tw-text-muted">
                <th class="py-2 pr-3 font-medium">Rank</th>
                <th class="py-2 pr-3 font-medium">Clinician</th>
                <th class="py-2 pr-3 font-medium">Score %</th>
                <th class="py-2 font-medium">Beds Stabilized</th>
              </tr>
            </thead>
            <tbody class="divide-y tw-border">
              {leaderboard.map((row, idx) => (
                <tr key={`${row.receipt}-${idx}`}>
                  <td class="py-2 pr-3 tw-mono-vital">#{row.rank ?? idx + 1}</td>
                  <td class="py-2 pr-3 font-medium">{row.clinicianAlias}</td>
                  <td class="py-2 pr-3 tw-mono-vital font-semibold tw-text-ecg">
                    {row.scorePct}%
                  </td>
                  <td class="py-2 tw-mono-vital text-xs tw-text-muted">
                    {row.bedsStabilized} / 4 · {row.receipt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Group 3: Compact CRC16 Receipt & Score Submission Strip */}
      <section class="tw-surface px-4 py-3 flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="m-0 text-base font-semibold">CRC16 Receipt</h2>
          {dailyReceipt ? (
            <strong data-testid="daily-receipt-code" class="tw-mono-vital text-sm px-2.5 py-1 rounded tw-chip-muted">
              {dailyReceipt}
            </strong>
          ) : (
            <span class="tw-mono-vital text-xs tw-text-muted">
              {formatDailyReceipt(
                utcDateKey,
                props.scoreSummary.scorePct,
                props.scoreSummary.bedsStabilized
              )}
            </span>
          )}
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
              class="h-10 px-3 rounded text-sm tw-input"
            />
          </div>

          <button
            type="button"
            data-testid="finish-daily-shift-btn"
            onClick={handleFinishDaily}
            class="tw-btn-secondary"
          >
            Submit Score
          </button>
        </div>
      </section>
    </div>
  );
}
