import { useEffect, useRef, useState } from 'preact/hooks';
import {
  generateCohortReceipt,
  parseCohortSeed,
  verifyCohortReceipt,
  type EntitlementTier,
  type VerifiedCohortReceipt,
} from '../../billing/cohortAndEntitlement.ts';
import {
  fetchCohortSubmissions,
  getFallbackBaselineCohortRoster,
  submitCohortRun,
  verifyReceiptRemote,
  type CohortSubmissionRecord,
  type CohortSummaryMetrics,
} from '../apiClient.ts';

export interface CohortProViewProps {
  entitlementTier: EntitlementTier;
  activeCohortSeed: string | null;
  checkoutNotice: string | null;
  scoreSummary: { scorePct: number; bedsStabilized: number; totalViolations: number };
  onActivateTier: (tier: 'exam_pass' | 'instructor_cohort') => void;
  onLaunchCohortShift: (cohortSeed: string) => void;
}

/**
 * Renders the Cohort Pro workspace with segmented tabs for Cohort Roster, Receipt Verifier, and Pro Access.
 */
export function CohortProView(props: CohortProViewProps) {
  const {
    entitlementTier,
    activeCohortSeed,
    checkoutNotice,
    scoreSummary,
    onActivateTier,
    onLaunchCohortShift,
  } = props;

  const initialSeed = activeCohortSeed ?? 'NURS402-FALL26';
  const [cohortInput, setCohortInput] = useState(initialSeed);
  const [cohortError, setCohortError] = useState<string | null>(null);
  const [studentAlias, setStudentAlias] = useState('K. Resident, PGY-2');
  const [roster, setRoster] = useState<CohortSubmissionRecord[]>(() =>
    getFallbackBaselineCohortRoster(initialSeed)
  );
  const [summary, setSummary] = useState<CohortSummaryMetrics>({
    totalSubmissions: 3,
    meanScore: 89,
    fullStabilizationRate: 67,
  });
  const [receiptToVerify, setReceiptToVerify] = useState('');
  const [verificationResult, setVerificationResult] = useState<
    (VerifiedCohortReceipt & { registeredInLedger?: boolean; online?: boolean }) | null
  >(null);
  const [activeTab, setActiveTab] = useState<'roster' | 'verifier' | 'access'>('roster');
  const cohortReqSeqRef = useRef(0);
  const verifyReqSeqRef = useRef(0);

  const parsedCurrentCohort = parseCohortSeed(cohortInput);
  const effectiveSeed =
    parsedCurrentCohort.valid && parsedCurrentCohort.cohort
      ? parsedCurrentCohort.cohort
      : 'NURS402-FALL26';

  useEffect(() => {
    verifyReqSeqRef.current++;
    setVerificationResult(null);
    const seq = ++cohortReqSeqRef.current;
    void fetchCohortSubmissions(effectiveSeed).then((res) => {
      if (cohortReqSeqRef.current === seq) {
        setRoster(res.roster);
        setSummary(res.summary);
      }
    });
    return () => {
      cohortReqSeqRef.current++;
    };
  }, [effectiveSeed]);

  const currentStudentReceipt = parsedCurrentCohort.valid
    ? generateCohortReceipt({
        cohort: parsedCurrentCohort.cohort!,
        scorePct: scoreSummary.scorePct,
        bedsStabilized: scoreSummary.bedsStabilized,
        violations: scoreSummary.totalViolations,
      })
    : null;

  const handleApplyCohort = (e: Event) => {
    e.preventDefault();
    const check = parseCohortSeed(cohortInput.trim());
    if (!check.valid || !check.cohort) {
      setCohortError(
        'Cohort seed requires 1 to 64 alphanumeric characters, hyphens, or underscores.'
      );
      return;
    }
    setCohortError(null);
    onLaunchCohortShift(check.cohort);
  };

  const handleSubmitCohortRun = (e: Event) => {
    e.preventDefault();
    const check = parseCohortSeed(cohortInput.trim());
    if (!check.valid || !check.cohort) {
      setCohortError('Enter a valid cohort seed before you submit a student run.');
      return;
    }
    setCohortError(null);
    const seq = ++cohortReqSeqRef.current;
    void submitCohortRun(check.cohort, {
      studentAlias: studentAlias.trim() || 'ICU Student',
      score: scoreSummary.scorePct,
      stabilizedBeds: scoreSummary.bedsStabilized,
      violations: scoreSummary.totalViolations,
    }).then((res) => {
      if (cohortReqSeqRef.current === seq) {
        setRoster(res.roster);
        setSummary(res.summary);
        if (!res.online) {
          setCohortError('Server offline: submission saved locally only and not confirmed in shared ledger.');
        }
      }
    });
  };

  const handleVerifyReceipt = (e: Event) => {
    e.preventDefault();
    const verifySeq = ++verifyReqSeqRef.current;
    const rawVerdict = verifyCohortReceipt(receiptToVerify);
    const localVerdict: VerifiedCohortReceipt =
      rawVerdict.valid &&
      rawVerdict.cohort &&
      rawVerdict.cohort.toUpperCase() !== effectiveSeed.toUpperCase()
        ? { ...rawVerdict, valid: false, reason: 'INVALID_COHORT' }
        : rawVerdict;
    setVerificationResult(localVerdict);
    void verifyReceiptRemote(receiptToVerify, effectiveSeed).then((remoteVerdict) => {
      if (verifyReqSeqRef.current !== verifySeq) return;
      if (
        remoteVerdict.valid &&
        remoteVerdict.cohort &&
        remoteVerdict.cohort.toUpperCase() !== effectiveSeed.toUpperCase()
      ) {
        setVerificationResult({ ...remoteVerdict, valid: false, reason: 'INVALID_COHORT' });
        return;
      }
      setVerificationResult(remoteVerdict);
    });
  };

  return (
    <div class="flex flex-col gap-4 max-w-5xl mx-auto">
      {checkoutNotice ? (
        <div class="tw-surface p-4 text-sm" role="status">
          {checkoutNotice}
        </div>
      ) : null}

      <section class="tw-surface divide-y tw-border">
        <div class="p-4 flex flex-wrap items-center justify-between gap-4">
          <h1>Cohort Roster and Access</h1>

          <div class="flex flex-wrap items-center gap-4">
            <div class="tw-seg-group" role="tablist" aria-label="Cohort workspace views">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'roster'}
                data-active={activeTab === 'roster' ? 'true' : 'false'}
                onClick={() => setActiveTab('roster')}
                class={activeTab === 'roster' ? 'tw-seg-btn-active' : 'tw-seg-btn'}
              >
                Cohort Roster
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'verifier'}
                data-active={activeTab === 'verifier' ? 'true' : 'false'}
                onClick={() => setActiveTab('verifier')}
                class={activeTab === 'verifier' ? 'tw-seg-btn-active' : 'tw-seg-btn'}
              >
                Receipt Verifier
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'access'}
                data-active={activeTab === 'access' ? 'true' : 'false'}
                onClick={() => setActiveTab('access')}
                class={activeTab === 'access' ? 'tw-seg-btn-active' : 'tw-seg-btn'}
              >
                Pro Access
              </button>
            </div>

            <div class="text-right">
              <div class="text-xs tw-text-muted">Active Tier</div>
              <strong
                data-testid="active-entitlement-badge"
                class="tw-mono-vital text-sm font-semibold"
              >
                {entitlementTier}
              </strong>
            </div>
          </div>
        </div>

        {/* Panel 1: Cohort Synchronizer & Live Roster */}
        <div class={activeTab === 'roster' ? 'divide-y tw-border block' : 'hidden'}>
          <div class="p-5 grid grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)] gap-6">
            <div>
              <h2 class="mt-2 mb-1">Cohort Seed Setup</h2>
            </div>

            <div class="flex flex-col gap-3">
              <form onSubmit={handleApplyCohort} class="flex flex-wrap items-end gap-3">
                <div class="flex-1 min-w-60">
                  <label htmlFor="cohort-seed-input" class="block text-sm font-medium mb-1 w-fit">
                    Cohort Seed Code *
                  </label>
                  <input
                    id="cohort-seed-input"
                    name="cohortSeed"
                    type="text"
                    autocomplete="off"
                    value={cohortInput}
                    onInput={(e) => setCohortInput((e.target as HTMLInputElement).value)}
                    class="w-full h-10 px-3 rounded tw-mono-vital text-sm tw-input"
                  />
                </div>

                <button type="submit" data-testid="launch-cohort-shift-btn" class="tw-btn-primary">
                  Launch Cohort
                </button>
              </form>

              <form onSubmit={handleSubmitCohortRun} class="flex flex-wrap items-end gap-3 pt-2">
                <div class="flex-1 min-w-60">
                  <label htmlFor="cohort-student-alias-input" class="block text-sm font-medium mb-1 w-fit">
                    Clinician Alias *
                  </label>
                  <input
                    id="cohort-student-alias-input"
                    name="studentAlias"
                    data-testid="cohort-student-alias-input"
                    type="text"
                    autocomplete="off"
                    value={studentAlias}
                    onInput={(e) => setStudentAlias((e.target as HTMLInputElement).value)}
                    class="w-full h-10 px-3 rounded text-sm tw-input"
                  />
                </div>

                <button
                  type="submit"
                  data-testid="submit-cohort-run-btn"
                  class="tw-btn-secondary"
                >
                  Submit Receipt
                </button>
              </form>

              {cohortError ? (
                <p class="m-0 text-sm tw-text-abp">{cohortError}</p>
              ) : null}

              {currentStudentReceipt ? (
                <div class="text-sm pt-1">
                  <span>Shift Completion Receipt: </span>
                  <strong data-testid="generated-cohort-receipt" class="tw-mono-vital">
                    {currentStudentReceipt}
                  </strong>
                </div>
              ) : null}
            </div>
          </div>

          <div class="p-5 flex flex-col gap-3">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <h2 class="mt-2 mb-1">Cohort Roster ({effectiveSeed})</h2>

              <div class="flex flex-wrap items-center gap-6 text-sm tw-mono-vital">
                <span>Runs: <strong>{summary.totalSubmissions}</strong></span>
                <span>Mean: <strong>{summary.meanScore}%</strong></span>
                <span>4/4 Rate: <strong>{summary.fullStabilizationRate}%</strong></span>
              </div>
            </div>

            <div class="overflow-x-auto">
              <table
                data-testid="cohort-roster-table"
                class="w-full text-left border-collapse text-sm"
              >
                <thead>
                  <tr class="border-b tw-border tw-text-muted">
                    <th class="py-2 pr-3 font-medium">Clinician</th>
                    <th class="py-2 pr-3 font-medium">Score</th>
                    <th class="py-2 pr-3 font-medium">Stabilized Beds</th>
                    <th class="py-2 font-medium">CRC16 Receipt</th>
                  </tr>
                </thead>
                <tbody class="divide-y tw-border">
                  {roster.map((row) => (
                    <tr key={row.id}>
                      <td class="py-2 pr-3 font-medium">{row.studentAlias}</td>
                      <td class="py-2 pr-3 tw-mono-vital font-semibold tw-text-ecg">
                        {row.score}%
                      </td>
                      <td class="py-2 pr-3 tw-mono-vital">
                        {row.stabilizedBeds} / 4 ({row.violations} err)
                      </td>
                      <td class="py-2 tw-mono-vital text-xs tw-text-muted">
                        {row.receipt}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Panel 2: Instructor CRC16 Receipt Verifier */}
        <div class={activeTab === 'verifier' ? 'p-5 grid grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)] gap-6' : 'hidden'}>
          <div>
            <h2 class="mt-2 mb-1">Receipt Verifier</h2>
          </div>

          <div class="flex flex-col gap-3">
            <form onSubmit={handleVerifyReceipt} class="flex flex-wrap items-end gap-3">
              <div class="flex-1 min-w-60">
                <label htmlFor="cohort-receipt-input" class="block text-sm font-medium mb-1 w-fit">
                  Completion Receipt Code *
                </label>
                <input
                  id="cohort-receipt-input"
                  name="receiptCode"
                  data-testid="cohort-receipt-input"
                  type="text"
                  autocomplete="off"
                  placeholder="TW-NURS402-FALL26-92-FD37"
                  value={receiptToVerify}
                  onInput={(e) => {
                    verifyReqSeqRef.current++;
                    setVerificationResult(null);
                    setReceiptToVerify((e.target as HTMLInputElement).value);
                  }}
                  class="w-full h-10 px-3 rounded tw-mono-vital text-sm tw-input"
                />
              </div>

              <button
                type="submit"
                data-testid="verify-cohort-receipt-btn"
                class="tw-btn-primary"
              >
                Verify Receipt
              </button>
            </form>

            {verificationResult ? (
              <div
                data-testid="cohort-receipt-verdict"
                class={`text-sm font-medium pt-1 ${
                  verificationResult.valid ? 'tw-text-ecg' : 'tw-text-abp'
                }`}
              >
                {verificationResult.valid
                  ? `VALID RECEIPT · Cohort ${verificationResult.cohort} · Score ${verificationResult.scorePct}% (${verificationResult.bedsStabilized}/4 beds, ${verificationResult.violations} violations)${
                      verificationResult.registeredInLedger === undefined
                        ? ''
                        : verificationResult.registeredInLedger
                          ? ' · Registered in Cohort Ledger'
                          : ' · Unregistered in Cohort Ledger'
                    }`
                  : `INVALID RECEIPT (${verificationResult.reason})`}
              </div>
            ) : null}
          </div>
        </div>

        {/* Panel 3: Stripe Checkout Pro Exam Pass ($19) & Instructor Tier ($49/mo) */}
        <div class={activeTab === 'access' ? 'p-5 grid grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)] gap-6' : 'hidden'}>
          <div>
            <h2 class="mt-2 mb-1">Plan Access</h2>
          </div>

          <div class="divide-y tw-border">
            <div class="pb-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 class="mt-2 mb-1">Pro Telemetry Exam Pass ($19)</h3>
              </div>
              <button
                type="button"
                data-testid="unlock-exam-pass-btn"
                onClick={() => onActivateTier('exam_pass')}
                class="tw-btn-primary"
              >
                {entitlementTier === 'exam_pass'
                  ? 'Exam Pass Active'
                  : 'Unlock Exam Pass'}
              </button>
            </div>

            <div class="pt-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 class="mt-2 mb-1">Instructor Cohort Pack ($49/mo)</h3>
              </div>
              <button
                type="button"
                data-testid="unlock-instructor-tier-btn"
                onClick={() => onActivateTier('instructor_cohort')}
                class="tw-btn-secondary"
              >
                {entitlementTier === 'instructor_cohort'
                  ? 'Cohort Pack Active'
                  : 'Unlock Cohort Pack'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
