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
import { AppShell, type ActiveRouteArea } from './ui/AppShell.tsx';
import { Iec60601AlarmSynthesizer } from './ui/audio/iec60601Alarms.ts';
import { CaliperView } from './ui/views/CaliperView.tsx';
import { CohortProView } from './ui/views/CohortProView.tsx';
import { DailyChallengeView } from './ui/views/DailyChallengeView.tsx';
import { ShiftStationView } from './ui/views/ShiftStationView.tsx';

export interface AppProps {
  initialPath?: string;
  preloadedDataset?: LoadedPtbxlDataset;
  initialSeed?: number;
}

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

  const alarmSynthRef = useRef<Iec60601AlarmSynthesizer | null>(null);
  if (!alarmSynthRef.current) {
    alarmSynthRef.current = new Iec60601AlarmSynthesizer();
  }
  const [audioArmed, setAudioArmed] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);

  // Parse path and optional ?cohort= or ?checkout= query parameters
  const [pathnamePart, searchPart = ''] = currentPath.split('?');
  const pathname = pathnamePart || '/shift';
  const urlParams = new URLSearchParams(searchPart);
  const rawCohortParam = urlParams.get('cohort');
  const parsedCohort = parseCohortSeed(rawCohortParam);
  const validCohortSeed = parsedCohort.valid ? parsedCohort.cohort : null;
  const checkoutParam = urlParams.get('checkout');

  const activeArea: ActiveRouteArea = pathname.startsWith('/daily')
    ? 'daily'
    : pathname.startsWith('/caliper')
      ? 'caliper'
      : pathname.startsWith('/cohort')
        ? 'cohort'
        : 'shift';

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
    if (checkoutParam === 'cancelled') {
      setCheckoutNotice(
        'Checkout cancelled — your free starter tier (24 PTB-XL records) remains active with zero charges.'
      );
    } else if (checkoutParam === 'success') {
      const tierParam = urlParams.get('tier');
      const tokenParam = urlParams.get('token')?.trim() ?? '';
      if (
        (tierParam === 'exam_pass' || tierParam === 'instructor_cohort') &&
        tokenParam !== ''
      ) {
        const res = activateEntitlement(tierParam, tokenParam, { allowSandboxMint: false });
        if (res.valid) {
          setEntitlementTier(res.tier);
          setCheckoutNotice(`Stripe Checkout verified — ${res.tier} unlocked.`);
        } else {
          setCheckoutNotice('Checkout token invalid or missing — entitlement remains free.');
        }
      } else {
        setCheckoutNotice('Checkout token invalid or missing — entitlement remains free.');
      }
    }
  }, [checkoutParam, searchPart]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      setCurrentPath(window.location.pathname + window.location.search);
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

  const navigate = (nextPath: string) => {
    const resolvedPath =
      validCohortSeed !== null && !nextPath.includes('?')
        ? `${nextPath}?cohort=${encodeURIComponent(validCohortSeed)}`
        : nextPath;
    setCurrentPath(resolvedPath);
    if (typeof window !== 'undefined' && !props.initialPath) {
      window.history.pushState({}, '', resolvedPath);
    }
  };

  const controller = activeArea === 'daily' ? dailyShiftRef.current : shiftRef.current;
  const beds = controller.getBeds();
  const activeBed = beds[selectedBedIndex] ?? beds[0]!;
  const scoreSummary = controller.computeShiftScore();

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
    const envObj = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const stripeUrl =
      tier === 'exam_pass'
        ? envObj?.VITE_STRIPE_EXAM_PASS_URL
        : envObj?.VITE_STRIPE_INSTRUCTOR_URL;

    if (typeof stripeUrl === 'string' && /^https?:\/\//i.test(stripeUrl.trim())) {
      window.location.assign(stripeUrl.trim());
      return;
    }

    const activated = activateEntitlement(tier, undefined, { allowSandboxMint: true });
    setEntitlementTier(activated.tier);
    setCheckoutNotice(
      `Sandbox Checkout completed: ${activated.tier} entitlement signed and persisted to localStorage.`
    );
  };

  const canAccessCase = (record: PtbxlCaseRecord): boolean => {
    return canAccessCaseWithEntitlement(record, entitlementTier, validCohortSeed);
  };

  const filteredRecords = (dataset?.records ?? []).filter((r) => {
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
      <div>
        <h2>ACLS Causal Timeline &amp; Hemodynamic Receipt</h2>
        <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
          {activeBed.bedLabel} ({activeBed.patientName}) · Active Rhythm:{' '}
          <strong class="tw-mono-vital">{activeBed.vitals.rhythm}</strong>
        </p>
      </div>

      <div class="border-t pt-3 flex flex-col gap-2.5" style={{ borderColor: 'var(--border)' }}>
        {activeBed.causalTimeline.map((ev, i) => (
          <div
            key={`${ev.tick}-${i}`}
            class="pb-2.5 border-b text-sm"
            style={{ borderColor: 'var(--border)' }}
          >
            <div class="flex items-center justify-between font-semibold">
              <span class="tw-mono-vital">t={ev.timeSec.toFixed(1)}s</span>
              <span class="tw-mono-vital">{ev.action}</span>
            </div>
            <div class="tw-mono-vital text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              {ev.preVitals.rhythm} ({ev.preVitals.sbp}/{ev.preVitals.dbp} mmHg) →{' '}
              {ev.postVitals.rhythm} ({ev.postVitals.sbp}/{ev.postVitals.dbp} mmHg)
            </div>
            {ev.ahaViolationCode ? (
              <div class="mt-1 font-semibold" style={{ color: 'var(--trace-abp)' }}>
                Violation: <span class="tw-mono-vital">{ev.ahaViolationCode}</span>
              </div>
            ) : null}
            <p class="m-0 mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
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
        <div class="border-t pt-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          <h3>PTB-XL Cardiologist Fiducial Ground Truth</h3>
          <p class="m-0 tw-mono-vital" style={{ color: 'var(--text-muted)' }}>
            {lastCaliperGrade.record.caseId} · PR {lastCaliperGrade.record.fiducials.prMs} ms · QRS{' '}
            {lastCaliperGrade.record.fiducials.qrsMs} ms · QTc{' '}
            {lastCaliperGrade.record.fiducials.qtcMs} ms · ST{' '}
            {lastCaliperGrade.record.fiducials.stMv} mV
          </p>
        </div>
      ) : lastCaliperGrade.record &&
        canAccessCaseWithEntitlement(
          lastCaliperGrade.record,
          entitlementTier,
          validCohortSeed
        ) ? (
        <div class="border-t pt-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          <p class="m-0" style={{ color: 'var(--text-muted)' }}>
            Position T1/T2 and V1/V2 calipers and click Grade 12-Lead Strip to reveal PTB-XL cardiologist fiducial ground truth.
          </p>
        </div>
      ) : null}
    </div>
  );

  const shiftResetKey = `${controller.getSeed()}:${resetCount}`;

  const caseIdFromRoute = pathname.startsWith('/caliper/')
    ? pathname.slice('/caliper/'.length) || 'ptbxl-001'
    : 'ptbxl-001';

  const cohortBanner = validCohortSeed
    ? `Cohort Mode Active: ${validCohortSeed}`
    : rawCohortParam !== null && !parsedCohort.valid
      ? 'Invalid ?cohort= parameter ignored; running default shift'
      : null;

  return (
    <AppShell
      activeArea={activeArea}
      currentPath={currentPath}
      onNavigate={navigate}
      beds={beds}
      selectedBedIndex={selectedBedIndex}
      onSelectBed={setSelectedBedIndex}
      records={filteredRecords}
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
            Retry Dataset Load
          </button>
        </div>
      ) : null}

      {activeArea === 'caliper' && !dataset && !loadError ? (
        <div class="tw-surface p-4 text-sm" role="status">
          Loading 120-record PhysioNet PTB-XL 500 Hz waveform dataset…
        </div>
      ) : null}

      {activeArea === 'shift' ? (
        <ShiftStationView
          stationTitle="ICU Central Telemetry Station · 4-Bed ACLS Shift"
          stationSubtitle="Scan 4 live 500 Hz bedside monitors, select any unstable bed, and deploy ACLS resuscitation before arrest."
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
          caseId={caseIdFromRoute}
          onSelectCaseId={(cid) => navigate(`/caliper/${cid}`)}
          canAccessCase={canAccessCase}
          onNavigateCohortUnlock={() => navigate('/cohort')}
          darkTheme={darkTheme}
          onGradeUpdate={(report, record) => setLastCaliperGrade({ report, record })}
        />
      ) : null}

      {activeArea === 'cohort' ? (
        <CohortProView
          entitlementTier={entitlementTier}
          activeCohortSeed={validCohortSeed}
          checkoutNotice={checkoutNotice}
          scoreSummary={scoreSummary}
          onActivateTier={handleActivateTier}
          onLaunchCohortShift={(seed) => navigate(`/shift?cohort=${seed}`)}
        />
      ) : null}
    </AppShell>
  );
}
