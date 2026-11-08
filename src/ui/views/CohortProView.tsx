import { useEffect, useState } from 'preact/hooks';
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
    (VerifiedCohortReceipt & { registeredInLedger?: boolean }) | null
  >(null);

  const parsedCurrentCohort = parseCohortSeed(cohortInput);
  const effectiveSeed = parsedCurrentCohort.valid && parsedCurrentCohort.cohort ? parsedCurrentCohort.cohort : 'NURS402-FALL26';

  useEffect(() => {
    let cancelled = false;
    void fetchCohortSubmissions(effectiveSeed).then((res) => {
      if (!cancelled) {
        setRoster(res.roster);
        setSummary(res.summary);
      }
    });
    return () => {
      cancelled = true;
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
        'Cohort seed must be 1 to 64 alphanumeric characters, hyphens, or underscores (/^[a-zA-Z0-9_-]{1,64}$/).'
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
      setCohortError('Enter a valid cohort seed before submitting a student run.');
      return;
    }
    setCohortError(null);
    void submitCohortRun(check.cohort, {
      studentAlias: studentAlias.trim() || 'ICU Student',
      score: scoreSummary.scorePct,
      stabilizedBeds: scoreSummary.bedsStabilized,
      violations: scoreSummary.totalViolations,
    }).then((res) => {
      setRoster(res.roster);
      setSummary(res.summary);
    });
  };

  const handleVerifyReceipt = (e: Event) => {
    e.preventDefault();
    const localVerdict = verifyCohortReceipt(receiptToVerify);
    setVerificationResult(localVerdict);
    void verifyReceiptRemote(receiptToVerify).then((remoteVerdict) => {
      setVerificationResult(remoteVerdict);
    });
  };

  return (
    <div class="flex flex-col gap-4">
      {checkoutNotice ? (
        <div class="tw-surface p-4 text-sm" role="status">
          {checkoutNotice}
        </div>
      ) : null}

      {/* Single divided settings-admin surface (zero nested cards) */}
      <section class="tw-surface divide-y" style={{ borderColor: 'var(--border)' }}>
        {/* Header Row */}
        <div class="p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1>Stateless Classroom Cohort Mode &amp; Pro Exam Pass</h1>
            <p class="text-sm m-0 tw-prose" style={{ color: 'var(--text-muted)' }}>
              Synchronize 4-bed ICU telemetry crises and 120 PhysioNet PTB-XL caliper strips across nursing or EMS classrooms via URL seed hashing, and verify student completion codes with CRC16 signatures.
            </p>
          </div>

          <div class="text-right">
            <div class="text-sm" style={{ color: 'var(--text-muted)' }}>
              Active Entitlement
            </div>
            <strong
              data-testid="active-entitlement-badge"
              class="tw-mono-vital text-base font-semibold"
            >
              {entitlementTier}
            </strong>
          </div>
        </div>

        {/* Section A: Stateless ?cohort=<seed> Classroom Synchronizer & Run Submission */}
        <div class="p-5 grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-6">
          <div>
            <h2>Classroom Cohort Synchronizer</h2>
            <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
              Generates a deterministic FNV-1a 32-bit seed so every student in a cohort faces the identical 4-bed arrhythmia sequence.
            </p>
          </div>

          <div class="flex flex-col gap-3">
            <form onSubmit={handleApplyCohort} class="flex flex-wrap items-end gap-3">
              <div class="flex-1 min-w-60">
                <label htmlFor="cohort-seed-input" class="block text-sm font-medium mb-1 w-fit">
                  Cohort Seed Identifier (?cohort=) *
                </label>
                <input
                  id="cohort-seed-input"
                  name="cohortSeed"
                  type="text"
                  autocomplete="off"
                  value={cohortInput}
                  onInput={(e) => setCohortInput((e.target as HTMLInputElement).value)}
                  class="w-full h-10 px-3 rounded border tw-mono-vital text-sm"
                  style={{
                    backgroundColor: 'var(--surface-muted)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                />
              </div>

              <button type="submit" data-testid="launch-cohort-shift-btn" class="tw-btn-primary">
                Launch Seeded Cohort Shift
              </button>
            </form>

            <form onSubmit={handleSubmitCohortRun} class="flex flex-wrap items-end gap-3 pt-2">
              <div class="flex-1 min-w-60">
                <label htmlFor="cohort-student-alias-input" class="block text-sm font-medium mb-1 w-fit">
                  Student Clinician Alias *
                </label>
                <input
                  id="cohort-student-alias-input"
                  name="studentAlias"
                  data-testid="cohort-student-alias-input"
                  type="text"
                  autocomplete="off"
                  value={studentAlias}
                  onInput={(e) => setStudentAlias((e.target as HTMLInputElement).value)}
                  class="w-full h-10 px-3 rounded border text-sm"
                  style={{
                    backgroundColor: 'var(--surface-muted)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                />
              </div>

              <button
                type="submit"
                data-testid="submit-cohort-run-btn"
                class="tw-btn-secondary"
              >
                Submit Shift Receipt to Cohort Roster
              </button>
            </form>

            {cohortError ? (
              <p class="m-0 text-sm" style={{ color: 'var(--trace-abp)' }}>
                {cohortError}
              </p>
            ) : null}

            {currentStudentReceipt ? (
              <div class="text-sm pt-1">
                <span>Current Shift Completion Receipt: </span>
                <strong data-testid="generated-cohort-receipt" class="tw-mono-vital">
                  {currentStudentReceipt}
                </strong>
              </div>
            ) : null}
          </div>
        </div>

        {/* Section B: Live Classroom Cohort Roster Table */}
        <div class="p-5 flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 class="m-0">Live Classroom Cohort Roster ({effectiveSeed})</h2>
              <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
                Server-persisted student resuscitation submissions signed with CRC16-CCITT verification codes.
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-6 text-sm tw-mono-vital">
              <span>Submissions: <strong>{summary.totalSubmissions}</strong></span>
              <span>Mean Score: <strong>{summary.meanScore}%</strong></span>
              <span>4/4 Stabilization Rate: <strong>{summary.fullStabilizationRate}%</strong></span>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table
              data-testid="cohort-roster-table"
              class="w-full text-left border-collapse text-sm"
            >
              <thead>
                <tr class="border-b" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                  <th class="py-2 pr-3 font-medium">Student Clinician</th>
                  <th class="py-2 pr-3 font-medium">Score</th>
                  <th class="py-2 pr-3 font-medium">Beds Stabilized</th>
                  <th class="py-2 pr-3 font-medium">AHA Violations</th>
                  <th class="py-2 font-medium">CRC16 Receipt Code</th>
                </tr>
              </thead>
              <tbody class="divide-y" style={{ borderColor: 'var(--border)' }}>
                {roster.map((row) => (
                  <tr key={row.id}>
                    <td class="py-2 pr-3 font-medium">{row.studentAlias}</td>
                    <td class="py-2 pr-3 tw-mono-vital font-semibold" style={{ color: 'var(--trace-ecg)' }}>
                      {row.score}%
                    </td>
                    <td class="py-2 pr-3 tw-mono-vital">{row.stabilizedBeds} / 4</td>
                    <td class="py-2 pr-3 tw-mono-vital">{row.violations}</td>
                    <td class="py-2 tw-mono-vital text-xs" style={{ color: 'var(--text-muted)' }}>
                      {row.receipt}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section C: Instructor CRC16 Receipt Verifier */}
        <div class="p-5 grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-6">
          <div>
            <h2>Instructor Receipt Verifier</h2>
            <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
              Paste a student completion code (TW-COHORT-SCORE-CRC16) to verify score integrity and cohort ledger registration.
            </p>
          </div>

          <div class="flex flex-col gap-3">
            <form onSubmit={handleVerifyReceipt} class="flex flex-wrap items-end gap-3">
              <div class="flex-1 min-w-60">
                <label htmlFor="cohort-receipt-input" class="block text-sm font-medium mb-1 w-fit">
                  Student Completion Receipt Code *
                </label>
                <input
                  id="cohort-receipt-input"
                  name="receiptCode"
                  data-testid="cohort-receipt-input"
                  type="text"
                  autocomplete="off"
                  placeholder="TW-NURS402-FALL26-92-FD37"
                  value={receiptToVerify}
                  onInput={(e) => setReceiptToVerify((e.target as HTMLInputElement).value)}
                  class="w-full h-10 px-3 rounded border tw-mono-vital text-sm"
                  style={{
                    backgroundColor: 'var(--surface-muted)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                />
              </div>

              <button
                type="submit"
                data-testid="verify-cohort-receipt-btn"
                class="tw-btn-secondary"
              >
                Verify CRC16 Signature
              </button>
            </form>

            {verificationResult ? (
              <div
                data-testid="cohort-receipt-verdict"
                class="text-sm font-medium pt-1"
                style={{
                  color: verificationResult.valid ? 'var(--trace-ecg)' : 'var(--trace-abp)',
                }}
              >
                {verificationResult.valid
                  ? `VALID RECEIPT · Cohort ${verificationResult.cohort} · Score ${verificationResult.scorePct}% (${verificationResult.bedsStabilized}/4 beds, ${verificationResult.violations} violations)`
                  : `INVALID RECEIPT (${verificationResult.reason})`}
              </div>
            ) : null}
          </div>
        </div>

        {/* Section D: Stripe Checkout Pro Exam Pass ($19) & Instructor Tier ($49/mo) */}
        <div class="p-5 grid grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] gap-6">
          <div>
            <h2>Self-Serve Exam Pass &amp; Licensing</h2>
            <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
              24 starter PTB-XL records (2 per rhythm class) are always free. Unlock all 120 cardiologist-annotated records for ACLS and NCLEX preparation.
            </p>
          </div>

          <div class="divide-y" style={{ borderColor: 'var(--border)' }}>
            <div class="pb-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3>ACLS &amp; NCLEX Pro Telemetry Exam Pass — $19 one-time</h3>
                <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
                  Unlocks all 120 curated 500 Hz 12-lead PTB-XL records, Bazett QTc grading overlays, and unlimited seeded MegaCode shifts.
                </p>
              </div>
              <button
                type="button"
                data-testid="unlock-exam-pass-btn"
                onClick={() => onActivateTier('exam_pass')}
                class="tw-btn-primary"
              >
                {entitlementTier === 'exam_pass'
                  ? 'Pro Exam Pass Active'
                  : 'Unlock Pro Exam Pass ($19)'}
              </button>
            </div>

            <div class="pt-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3>Clinical Instructor Cohort Pack — $49 / month</h3>
                <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
                  Unlocks unlimited ?cohort= classroom assignments, full 120-record caliper access for students, and batch CRC16 receipt verification.
                </p>
              </div>
              <button
                type="button"
                data-testid="unlock-instructor-tier-btn"
                onClick={() => onActivateTier('instructor_cohort')}
                class="tw-btn-secondary"
              >
                {entitlementTier === 'instructor_cohort'
                  ? 'Instructor Tier Active'
                  : 'Activate Instructor Cohort Tier ($49/mo)'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
