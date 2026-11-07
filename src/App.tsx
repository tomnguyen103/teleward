import { useEffect, useRef, useState } from 'preact/hooks';
import {
  loadPtbxlBinary,
  type LoadedPtbxlDataset,
} from './data/ptbxlLoader.ts';
import { ShiftController } from './engine/aclsEngine.ts';
import { fnv1a32, getDailySeed } from './engine/prng.ts';
import type {
  AclsInterventionId,
  PtbxlCaseRecord,
  PtbxlIndexManifest,
  RhythmClass,
} from './types/teleward.ts';
import { AppShell, type ActiveRouteArea } from './ui/AppShell.tsx';
import { Iec60601AlarmSynthesizer } from './ui/audio/iec60601Alarms.ts';
import type { CaliperGradeReport } from './ui/canvas/TelemetryCanvas.ts';
import { CaliperView } from './ui/views/CaliperView.tsx';
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
  const [darkTheme, setDarkTheme] = useState(true);
  const [selectedBedIndex, setSelectedBedIndex] = useState(0);
  const [activeRhythmFilter, setActiveRhythmFilter] = useState<RhythmClass | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [renderTick, setRenderTick] = useState(0);
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

  // Parse path and optional ?cohort= query
  const [pathnamePart, searchPart = ''] = currentPath.split('?');
  const pathname = pathnamePart || '/shift';
  const urlParams = new URLSearchParams(searchPart);
  const rawCohortParam = urlParams.get('cohort');
  const validCohortSeed =
    rawCohortParam && /^[a-zA-Z0-9_-]{1,64}$/.test(rawCohortParam) ? rawCohortParam : null;

  const activeArea: ActiveRouteArea = pathname.startsWith('/daily')
    ? 'daily'
    : pathname.startsWith('/caliper')
      ? 'caliper'
      : pathname.startsWith('/cohort')
        ? 'cohort'
        : 'shift';

  const effectiveSeed =
    props.initialSeed ??
    (activeArea === 'daily'
      ? getDailySeed()
      : validCohortSeed
        ? fnv1a32(validCohortSeed)
        : 42);

  const shiftRef = useRef<ShiftController | null>(null);
  if (!shiftRef.current || shiftRef.current.getSeed() !== effectiveSeed) {
    shiftRef.current = new ShiftController(effectiveSeed);
  }

  useEffect(() => {
    if (dataset) return;
    let cancelled = false;
    async function fetchBinaryAndManifest() {
      try {
        const [binRes, idxRes] = await Promise.all([
          fetch('/data/ptbxl_120.bin'),
          fetch('/data/ptbxl_index.json'),
        ]);
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
  }, [dataset]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', darkTheme ? 'dark' : 'light');
    }
  }, [darkTheme]);

  const navigate = (nextPath: string) => {
    setCurrentPath(nextPath);
    if (typeof window !== 'undefined' && !props.initialPath) {
      window.history.pushState({}, '', nextPath);
    }
  };

  const controller = shiftRef.current;
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
    const priorities = controller.getBeds().map((b) => b.alarmPriority);
    alarmSynthRef.current?.arbitratePriority(priorities);
    setRenderTick((t) => t + 1);
  };

  const handleResetShift = () => {
    shiftRef.current = new ShiftController(effectiveSeed);
    setRenderTick((t) => t + 1);
  };

  const handleToggleAudio = () => {
    const synth = alarmSynthRef.current!;
    if (!synth.isArmed()) {
      const ok = synth.armAudio();
      setAudioArmed(ok);
      setAudioMuted(false);
    } else {
      const nextMute = !synth.isMuted();
      synth.setMuted(nextMute);
      setAudioMuted(nextMute);
    }
  };

  const canAccessCase = (record: PtbxlCaseRecord): boolean => {
    if (record.freeStarter) return true;
    if (validCohortSeed) return true;
    return false;
  };

  const filteredRecords = (dataset?.records ?? []).filter((r) => {
    if (activeRhythmFilter !== 'ALL' && r.rhythmClass !== activeRhythmFilter) {
      return false;
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.trim().toLowerCase();
      return (
        r.caseId.toLowerCase().includes(q) ||
        r.rhythmClass.toLowerCase().includes(q) ||
        r.clinicalSummary.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Inspector Content: Causal Timeline & Hemodynamic Receipt on /shift & /daily, or Fiducial Ledger on /caliper
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

      {lastCaliperGrade.record ? (
        <div class="border-t pt-3 text-sm" style={{ borderColor: 'var(--border)' }}>
          <h3>PTB-XL Cardiologist Fiducial Ground Truth</h3>
          <p class="m-0 tw-mono-vital" style={{ color: 'var(--text-muted)' }}>
            {lastCaliperGrade.record.caseId} · PR {lastCaliperGrade.record.fiducials.prMs} ms · QRS{' '}
            {lastCaliperGrade.record.fiducials.qrsMs} ms · QTc{' '}
            {lastCaliperGrade.record.fiducials.qtcMs} ms · ST{' '}
            {lastCaliperGrade.record.fiducials.stMv} mV
          </p>
        </div>
      ) : null}
    </div>
  );

  const caseIdFromRoute = pathname.startsWith('/caliper/')
    ? pathname.slice('/caliper/'.length) || 'ptbxl-001'
    : 'ptbxl-001';

  return (
    <AppShell
      activeArea={activeArea}
      currentPath={currentPath}
      onNavigate={navigate}
      beds={beds}
      selectedBedIndex={selectedBedIndex}
      onSelectBed={setSelectedBedIndex}
      records={filteredRecords}
      activeRhythmFilter={activeRhythmFilter}
      onSelectRhythmFilter={setActiveRhythmFilter}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      audioArmed={audioArmed}
      audioMuted={audioMuted}
      onToggleAudioArmOrMute={handleToggleAudio}
      darkTheme={darkTheme}
      onToggleTheme={() => setDarkTheme((d) => !d)}
      cohortBannerText={validCohortSeed ? `Cohort Mode Active: ${validCohortSeed}` : null}
      inspectorContent={inspectorContent}
    >
      {loadError ? (
        <div class="tw-surface p-4 text-sm" role="alert">
          {loadError}
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
    </AppShell>
  );
}
