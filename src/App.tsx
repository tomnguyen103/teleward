import { useEffect, useRef, useState } from 'preact/hooks';
import {
  activateEntitlement,
  canAccessCaseWithEntitlement,
  parseCohortSeed,
  readEntitlementFromStorage,
  type EntitlementTier,
} from './billing/cohortAndEntitlement.ts';
import {
  loadPtbxlBinary,
  type LoadedPtbxlDataset,
} from './data/ptbxlLoader.ts';
import { ShiftController } from './engine/aclsEngine.ts';
import { getDailySeed } from './engine/prng.ts';
import type {
  AclsInterventionId,
  PtbxlCaseRecord,
  PtbxlIndexManifest,
  RhythmClass,
} from './types/teleward.ts';
import type { CaliperGradeReport } from './engine/caliperGrading.ts';
import { requestEntitlementCheckout } from './ui/apiClient.ts';
import { AppShell, type ActiveRouteArea } from './ui/AppShell.tsx';
import { Iec60601AlarmSynthesizer } from './ui/audio/iec60601Alarms.ts';
import { buildCohortSubPath, parseTelewardRoute } from './ui/router.ts';
import { CaliperView } from './ui/views/CaliperView.tsx';
import { CohortProView } from './ui/views/CohortProView.tsx';
import { DailyChallengeView } from './ui/views/DailyChallengeView.tsx';
import { ShiftStationView } from './ui/views/ShiftStationView.tsx';

export interface AppProps {
  initialPath?: string;
  preloadedDataset?: LoadedPtbxlDataset;
  initialSeed?: number;
}

/**
 * Root TeleWard workbench component managing route state, PTB-XL binary dataset loading, ACLS simulation controllers, and entitlements.
 */
export function App(props: AppProps) {
  const [currentPath, setCurrentPath] = useState<string>(() => {
    if (props.initialPath) return props.initialPath;
    if (typeof window !== 'undefined') {
      return window.location.pathname + window.location.search;
    }
    return '/shift';
  });

  const [dataset, setDataset] = useState<LoadedPtbxlDataset | null>(
    props.preloadedDataset ?? null
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [darkTheme, setDarkTheme] = useState(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    return true;
  });
  const [selectedBedIndex, setSelectedBedIndex] = useState(0);
  const [activeRhythmFilter, setActiveRhythmFilter] = useState<RhythmClass | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [renderTick, setRenderTick] = useState(0);
  const [resetCount, setResetCount] = useState(0);
  const [entitlementTier, setEntitlementTier] = useState<EntitlementTier>(
    () => readEntitlementFromStorage().tier
  );
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [lastCaliperGrade, setLastCaliperGrade] = useState<{
    report: CaliperGradeReport | null;
    record: PtbxlCaseRecord | null;
  }>({ report: null, record: null });
  const [sessionCohortSeed, setSessionCohortSeed] = useState<string | null>(() => {
    if (typeof window === 'undefined' || props.initialPath) return null;
    try {
      const fromHistory = (window.history?.state as { cohortSeed?: string | null } | null)
        ?.cohortSeed;
      if (typeof fromHistory === 'string' && fromHistory.trim() !== '') {
        return fromHistory;
      }
      const fromStorage = window.sessionStorage?.getItem('teleward_active_cohort_seed_v1');
      return typeof fromStorage === 'string' && fromStorage.trim() !== '' ? fromStorage : null;
    } catch {
      return null;
    }
  });

  const alarmSynthRef = useRef<Iec60601AlarmSynthesizer | null>(null);
  if (!alarmSynthRef.current) {
    alarmSynthRef.current = new Iec60601AlarmSynthesizer();
  }
  const [audioArmed, setAudioArmed] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const checkoutSeqRef = useRef(0);

  const parsedRoute = parseTelewardRoute(currentPath);
  const activeArea: ActiveRouteArea = parsedRoute.area;
  const validCohortSeed = parsedRoute.invalidCohortParam
    ? null
    : parsedRoute.cohortSeed ?? sessionCohortSeed;
  const parsedCohort = parseCohortSeed(validCohortSeed);

  const shiftSeed =
    (props.initialSeed ??
      (parsedCohort.valid && parsedCohort.numericSeed !== null ? parsedCohort.numericSeed : 42)) >>>
    0;
  const dailySeed = (props.initialSeed ?? getDailySeed()) >>> 0;

  const shiftRef = useRef<ShiftController | null>(null);
  if (!shiftRef.current || shiftRef.current.getSeed() !== shiftSeed) {
    shiftRef.current = new ShiftController(shiftSeed);
  }

  const dailyShiftRef = useRef<ShiftController | null>(null);
  if (!dailyShiftRef.current || dailyShiftRef.current.getSeed() !== dailySeed) {
    dailyShiftRef.current = new ShiftController(dailySeed);
  }

  useEffect(() => {
    if (parsedRoute.cohortSeed) {
      setSessionCohortSeed(parsedRoute.cohortSeed);
      try {
        window.sessionStorage?.setItem('teleward_active_cohort_seed_v1', parsedRoute.cohortSeed);
      } catch {
        // Ignore storage restrictions
      }
    }
  }, [parsedRoute.cohortSeed]);

  useEffect(() => {
    if (parsedRoute.checkoutStatus === 'cancelled') {
      setCheckoutNotice('Checkout cancelled. Free starter access stays active.');
    } else if (parsedRoute.checkoutStatus === 'success') {
      const tierParam = parsedRoute.checkoutTier;
      const tokenParam = parsedRoute.checkoutToken?.trim() ?? '';
      if (
        (tierParam === 'exam_pass' || tierParam === 'instructor_cohort') &&
        tokenParam !== ''
      ) {
        const res = activateEntitlement(tierParam, tokenParam, { allowSandboxMint: false });
        if (res.valid) {
          setEntitlementTier(res.tier);
          setCheckoutNotice(`Stripe Checkout verified. ${res.tier} unlocked.`);
        } else {
          setCheckoutNotice('Checkout token invalid or missing. Free tier stays active.');
        }
      } else {
        setCheckoutNotice('Checkout token invalid or missing. Free tier stays active.');
      }
    }
  }, [parsedRoute.checkoutStatus, parsedRoute.checkoutTier, parsedRoute.checkoutToken]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = (e: PopStateEvent) => {
      const nextUrl = window.location.pathname + window.location.search;
      const poppedRoute = parseTelewardRoute(nextUrl);
      const stateSeed = (e.state as { cohortSeed?: string | null } | null)?.cohortSeed;
      const resolvedSeed = poppedRoute.cohortSeed ?? (stateSeed !== undefined ? stateSeed : null);
      setSessionCohortSeed(resolvedSeed);
      try {
        if (resolvedSeed) {
          window.sessionStorage?.setItem('teleward_active_cohort_seed_v1', resolvedSeed);
        } else {
          window.sessionStorage?.removeItem('teleward_active_cohort_seed_v1');
        }
      } catch {
        // Ignore storage restrictions
      }
      setCurrentPath(nextUrl);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const searchEl = document.getElementById('tw-global-search') as HTMLInputElement | null;
        searchEl?.focus();
      }
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    return () => {
      alarmSynthRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (dataset) return;
    let cancelled = false;
    async function fetchBinaryAndManifest() {
      try {
        setLoadError(null);
        const [binRes, idxRes] = await Promise.all([
          fetch('/data/ptbxl_120.bin'),
          fetch('/data/ptbxl_index.json'),
        ]);
        if (!binRes.ok || !idxRes.ok) {
          throw new Error(
            `Failed to fetch PTB-XL assets (bin=${binRes.status}, index=${idxRes.status}).`
          );
        }
        const [binAb, manifestJson] = await Promise.all([
          binRes.arrayBuffer(),
          idxRes.json() as Promise<PtbxlIndexManifest>,
        ]);
        if (!cancelled) {
          setDataset(loadPtbxlBinary(binAb, manifestJson));
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load PTB-XL binary.');
        }
      }
    }
    void fetchBinaryAndManifest();
    return () => {
      cancelled = true;
    };
  }, [dataset, retryCount]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', darkTheme ? 'dark' : 'light');
    }
  }, [darkTheme]);

  const navigate = (nextPath: string, explicitCohortSeed?: string | null) => {
    const nextRoute = parseTelewardRoute(nextPath);
    const seedToStore =
      explicitCohortSeed !== undefined
        ? explicitCohortSeed
        : nextRoute.cohortSeed ?? validCohortSeed;
    setCurrentPath(nextPath);
    if (typeof window !== 'undefined' && !props.initialPath) {
      window.history.pushState({ cohortSeed: seedToStore }, '', nextPath);
    }
  };

  const controller = activeArea === 'daily' ? dailyShiftRef.current : shiftRef.current;
  const beds = controller.getBeds();
  const activeBed = beds[selectedBedIndex] ?? beds[0]!;
  const scoreSummary = controller.computeShiftScore();
  const shiftInterventionsLog = shiftRef.current
    .getBeds()
    .flatMap((b) =>
      b.causalTimeline
        .filter((ev) => ev.action !== 'SCENARIO_START' && ev.action !== 'ISCHEMIC_ARREST')
        .map((ev) => ({
          bedIndex: b.bedIndex,
          action: String(ev.action),
          atSec: ev.timeSec,
          tick: ev.tick,
        }))
    )
    .sort((a, b) => a.tick - b.tick)
    .map(({ bedIndex, action, atSec }) => ({ bedIndex, action, atSec }));

  const handleApplyIntervention = (bedIndex: number, action: AclsInterventionId) => {
    controller.applyIntervention(bedIndex, action);
    const priorities = controller.getBeds().map((b) => b.alarmPriority);
    alarmSynthRef.current?.arbitratePriority(priorities);
    alarmSynthRef.current?.triggerBurstIfDue(activeBed.vitals.spo2);
    setRenderTick((t) => t + 1);
  };

  const handleStepSimulation = (deltaSec: number) => {
    controller.stepSeconds(deltaSec);
    const updatedBeds = controller.getBeds();
    const priorities = updatedBeds.map((b) => b.alarmPriority);
    alarmSynthRef.current?.arbitratePriority(priorities);
    const updatedActiveBed = updatedBeds[selectedBedIndex] ?? updatedBeds[0]!;
    alarmSynthRef.current?.triggerBurstIfDue(updatedActiveBed.vitals.spo2);
    setRenderTick((t) => t + 1);
  };

  const handleResetShift = () => {
    if (activeArea === 'daily') {
      const nextController = new ShiftController(dailySeed);
      dailyShiftRef.current = nextController;
      const priorities = nextController.getBeds().map((b) => b.alarmPriority);
      alarmSynthRef.current?.arbitratePriority(priorities);
    } else {
      const nextController = new ShiftController(shiftSeed);
      shiftRef.current = nextController;
      const priorities = nextController.getBeds().map((b) => b.alarmPriority);
      alarmSynthRef.current?.arbitratePriority(priorities);
    }
    setResetCount((c) => c + 1);
    setRenderTick((t) => t + 1);
  };

  const handleToggleAudio = () => {
    const synth = alarmSynthRef.current!;
    if (!synth.isArmed()) {
      const ok = synth.armAudio();
      setAudioArmed(ok);
      setAudioMuted(false);
      void synth.arm().then((armed) => {
        setAudioArmed(armed);
      });
      const priorities = controller.getBeds().map((b) => b.alarmPriority);
      synth.arbitratePriority(priorities);
      synth.triggerBurstIfDue(activeBed.vitals.spo2);
    } else {
      const nextMute = !synth.isMuted();
      synth.setMuted(nextMute);
      setAudioMuted(nextMute);
      if (!nextMute) {
        const priorities = controller.getBeds().map((b) => b.alarmPriority);
        synth.arbitratePriority(priorities);
        synth.triggerBurstIfDue(activeBed.vitals.spo2);
      }
    }
  };

  const handleActivateTier = (tier: 'exam_pass' | 'instructor_cohort') => {
    const envObj = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    const stripeUrl =
      tier === 'exam_pass'
        ? (envObj?.VITE_STRIPE_EXAM_PASS_URL as string | undefined)
        : (envObj?.VITE_STRIPE_INSTRUCTOR_URL as string | undefined);

    if (typeof stripeUrl === 'string' && /^https?:\/\//i.test(stripeUrl.trim())) {
      window.location.assign(stripeUrl.trim());
      return;
    }

    const allowSandboxMint = Boolean(envObj?.DEV || envObj?.MODE === 'test');
    const seq = ++checkoutSeqRef.current;
    const activated = activateEntitlement(tier, undefined, { allowSandboxMint });
    if (activated.valid) {
      setEntitlementTier(activated.tier);
      setCheckoutNotice(
        `Sandbox Checkout complete: ${activated.tier} token signed and stored.`
      );
    } else {
      setCheckoutNotice('Checkout verification in progress.');
    }
    void requestEntitlementCheckout(tier, undefined, { allowSandboxMint }).then((remote) => {
      if (checkoutSeqRef.current !== seq) return;
      if (remote.valid && remote.token && (remote.online || allowSandboxMint)) {
        const synced = activateEntitlement(tier, remote.token, { allowSandboxMint });
        if (synced.valid) {
          setEntitlementTier(synced.tier);
          setCheckoutNotice(
            `Checkout complete: ${synced.tier} token signed and stored.`
          );
          return;
        }
      }
      if (!activated.valid) {
        setCheckoutNotice('Checkout requires verified Stripe payment.');
      }
    });
  };

  const canAccessCase = (record: PtbxlCaseRecord): boolean => {
    return canAccessCaseWithEntitlement(record, entitlementTier, validCohortSeed);
  };

  const allRecords = dataset?.records ?? [];

  const filteredRecords = allRecords.filter((r) => {
    const unlocked = canAccessCaseWithEntitlement(r, entitlementTier, validCohortSeed);
    if (activeRhythmFilter !== 'ALL') {
      if (!unlocked || r.rhythmClass !== activeRhythmFilter) {
        return false;
      }
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.trim().toLowerCase();
      if (r.caseId.toLowerCase().includes(q)) {
        return true;
      }
      if (!unlocked) {
        return false;
      }
      return (
        r.rhythmClass.toLowerCase().includes(q) ||
        r.clinicalSummary.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const inspectorContent = (
    <div class="flex flex-col gap-4" data-tick={renderTick}>
      <div class="flex items-center justify-between gap-2">
        <h2 class="m-0">ACLS Causal Timeline &amp; Hemodynamic Receipt</h2>
        <span class="tw-mono-vital text-xs px-2 py-0.5 rounded tw-chip-muted">
          {activeBed.bedLabel} · {activeBed.vitals.rhythm}
        </span>
      </div>

      <div class="border-t pt-3 flex flex-col gap-2.5 tw-border">
        {activeBed.causalTimeline.map((ev, i) => (
          <div
            key={`${ev.tick}-${i}`}
            class="pb-2.5 border-b text-sm tw-border"
          >
            <div class="flex items-center justify-between font-semibold">
              <span class="tw-mono-vital">t={ev.timeSec.toFixed(1)}s</span>
              <span class="tw-mono-vital">{ev.action}</span>
            </div>
            <div class="tw-mono-vital text-sm mt-1 tw-text-muted">
              {ev.preVitals.rhythm} ({ev.preVitals.sbp}/{ev.preVitals.dbp} mmHg) →{' '}
              {ev.postVitals.rhythm} ({ev.postVitals.sbp}/{ev.postVitals.dbp} mmHg)
            </div>
            {ev.ahaViolationCode ? (
              <div class="mt-1 font-semibold tw-text-abp">
                Violation: <span class="tw-mono-vital">{ev.ahaViolationCode}</span>
              </div>
            ) : null}
            <p class="m-0 mt-1 text-sm tw-text-muted">
              {ev.rationale}
            </p>
          </div>
        ))}
      </div>

      {lastCaliperGrade.report !== null &&
      lastCaliperGrade.record &&
      canAccessCaseWithEntitlement(
        lastCaliperGrade.record,
        entitlementTier,
        validCohortSeed
      ) ? (
        <div class="border-t pt-3 text-sm tw-border">
          <h3 class="m-0 mb-1">PTB-XL Cardiologist Fiducial Ground Truth</h3>
          <div class="tw-mono-vital tw-text-muted">
            {lastCaliperGrade.record.caseId} · PR {lastCaliperGrade.record.fiducials.prMs} ms · QRS{' '}
            {lastCaliperGrade.record.fiducials.qrsMs} ms · QTc{' '}
            {lastCaliperGrade.record.fiducials.qtcMs} ms · ST{' '}
            {lastCaliperGrade.record.fiducials.stMv} mV
          </div>
        </div>
      ) : lastCaliperGrade.record &&
        canAccessCaseWithEntitlement(
          lastCaliperGrade.record,
          entitlementTier,
          validCohortSeed
        ) ? (
        <div class="border-t pt-3 text-sm tw-border">
          <p class="m-0 tw-text-muted">
            Place T1, T2, V1, and V2 calipers and grade the strip to reveal PTB-XL ground truth.
          </p>
        </div>
      ) : null}
    </div>
  );

  const shiftResetKey = `${controller.getSeed()}:${resetCount}`;

  const caseIdFromRoute = parsedRoute.caseId;

  const cohortBanner = validCohortSeed
    ? `Cohort Mode Active: ${validCohortSeed}`
    : parsedRoute.invalidCohortParam
      ? 'Invalid cohort parameter ignored. Default shift is active.'
      : null;

  return (
    <AppShell
      activeArea={activeArea}
      currentPath={currentPath}
      onNavigate={navigate}
      beds={beds}
      selectedBedIndex={selectedBedIndex}
      onSelectBed={setSelectedBedIndex}
      records={allRecords}
      canAccessCase={canAccessCase}
      activeRhythmFilter={activeRhythmFilter}
      onSelectRhythmFilter={setActiveRhythmFilter}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      audioArmed={audioArmed}
      audioMuted={audioMuted}
      onToggleAudioArmOrMute={handleToggleAudio}
      darkTheme={darkTheme}
      onToggleTheme={() => setDarkTheme((d) => !d)}
      cohortBannerText={cohortBanner}
      inspectorContent={inspectorContent}
    >
      {loadError ? (
        <div class="tw-surface p-4 text-sm flex flex-wrap items-center justify-between gap-3" role="alert">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            class="tw-btn-secondary text-sm"
          >
            Retry Load
          </button>
        </div>
      ) : null}

      {activeArea === 'caliper' && !dataset && !loadError ? (
        <div class="tw-surface p-4 text-sm" role="status">
          TeleWard loads 120 PTB-XL 500 Hz ECG records.
        </div>
      ) : null}

      {activeArea === 'shift' ? (
        <ShiftStationView
          stationTitle="Central Telemetry Shift"
          beds={beds}
          selectedBedIndex={selectedBedIndex}
          onSelectBed={setSelectedBedIndex}
          onApplyIntervention={handleApplyIntervention}
          onResetShift={handleResetShift}
          onStepSimulation={handleStepSimulation}
          onOpenCaliperForCase={(cid) => navigate(`/caliper/${cid}`)}
          scoreSummary={scoreSummary}
          shiftResetKey={shiftResetKey}
        />
      ) : null}

      {activeArea === 'daily' ? (
        <DailyChallengeView
          beds={beds}
          selectedBedIndex={selectedBedIndex}
          onSelectBed={setSelectedBedIndex}
          onApplyIntervention={handleApplyIntervention}
          onResetShift={handleResetShift}
          onStepSimulation={handleStepSimulation}
          onOpenCaliperForCase={(cid) => navigate(`/caliper/${cid}`)}
          scoreSummary={scoreSummary}
          shiftResetKey={shiftResetKey}
        />
      ) : null}

      {activeArea === 'caliper' && dataset ? (
        <CaliperView
          dataset={dataset}
          filteredRecords={filteredRecords}
          caseId={caseIdFromRoute}
          onSelectCaseId={(cid) => navigate(`/caliper/${cid}`)}
          canAccessCase={canAccessCase}
          onNavigateCohortUnlock={() => navigate('/cohort/billing')}
          darkTheme={darkTheme}
          onGradeUpdate={(report, record) => setLastCaliperGrade({ report, record })}
        />
      ) : null}

      {activeArea === 'cohort' ? (
        <CohortProView
          entitlementTier={entitlementTier}
          activeCohortSeed={validCohortSeed}
          cohortSubRoute={parsedRoute.cohortSubRoute}
          onSelectSubRoute={(sub, seed) =>
            navigate(buildCohortSubPath(sub, seed ?? validCohortSeed), seed ?? validCohortSeed)
          }
          checkoutNotice={checkoutNotice}
          scoreSummary={scoreSummary}
          interventionsLog={shiftInterventionsLog}
          onActivateTier={handleActivateTier}
          onLaunchCohortShift={(seed) => {
            setSessionCohortSeed(seed);
            try {
              window.sessionStorage?.setItem('teleward_active_cohort_seed_v1', seed);
            } catch {
              // Ignore storage restrictions
            }
            navigate(`/shift/cohort/${encodeURIComponent(seed)}`, seed);
          }}
        />
      ) : null}
    </AppShell>
  );
}
