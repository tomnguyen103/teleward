import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getCaseById,
  getCaseWaveforms,
  type LoadedPtbxlDataset,
} from '../../data/ptbxlLoader.ts';
import { RHYTHM_CLASSES, type PtbxlCaseRecord, type RhythmClass } from '../../types/teleward.ts';
import {
  computeCaliperMetrics,
  gradeCaliperSubmission,
  nudgeCaliperState,
  type CaliperGradeReport,
  type CaliperState,
} from '../../engine/caliperGrading.ts';
import {
  getCaliperStripGeometry,
  getSafe2dContext,
  render12LeadCaliperCanvas,
  syncCanvasHiDpi,
} from '../canvas/TelemetryCanvas.ts';

export type CaliperHandleId = 't1' | 't2' | 'v1' | 'v2';

if (typeof window !== 'undefined') {
  if (typeof window.PointerEvent === 'undefined') {
    (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = window.MouseEvent;
  }
  if (typeof HTMLElement !== 'undefined') {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    for (const ev of ['onpointerdown', 'onpointermove', 'onpointerup', 'onpointercancel']) {
      if (!(ev in proto)) {
        proto[ev] = null;
      }
    }
  }
}

export function hitTestCaliperHandle(
  localX: number,
  localY: number,
  width: number,
  height: number,
  caliper: CaliperState,
  fallbackHandle: CaliperHandleId,
  gainMmPerMv: 5 | 10 | 20 = 10,
  thresholdPx = 18,
  paperSpeedMmPerSec: 25 | 50 = 25
): CaliperHandleId {
  const geom = getCaliperStripGeometry(width, height, paperSpeedMmPerSec, gainMmPerMv);
  const xT1 = geom.msToX(caliper.t1Ms);
  const xT2 = geom.msToX(caliper.t2Ms);
  const yV1 = geom.mvToY(caliper.v1Mv);
  const yV2 = geom.mvToY(caliper.v2Mv);

  const candidates: Array<{ handle: CaliperHandleId; dist: number }> = [
    { handle: 't1', dist: Math.abs(localX - xT1) },
    { handle: 't2', dist: Math.abs(localX - xT2) },
    { handle: 'v1', dist: Math.abs(localY - yV1) },
    { handle: 'v2', dist: Math.abs(localY - yV2) },
  ];

  candidates.sort((a, b) => {
    const diff = a.dist - b.dist;
    if (Math.abs(diff) < 1e-6) {
      if (a.handle === fallbackHandle) return -1;
      if (b.handle === fallbackHandle) return 1;
    }
    return diff;
  });
  const nearest = candidates[0]!;
  if (nearest.dist <= thresholdPx) {
    return nearest.handle;
  }
  return fallbackHandle;
}

export interface CaliperViewProps {
  dataset: LoadedPtbxlDataset;
  filteredRecords?: readonly PtbxlCaseRecord[];
  caseId: string;
  onSelectCaseId: (caseId: string) => void;
  canAccessCase: (record: PtbxlCaseRecord) => boolean;
  onNavigateCohortUnlock: () => void;
  darkTheme: boolean;
  onGradeUpdate?: (report: CaliperGradeReport | null, record: PtbxlCaseRecord | null) => void;
}

export function CaliperView(props: CaliperViewProps) {
  const {
    dataset,
    filteredRecords,
    caseId,
    onSelectCaseId,
    canAccessCase,
    onNavigateCohortUnlock,
    darkTheme,
    onGradeUpdate,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef(false);
  const draggingHandleRef = useRef<CaliperHandleId | null>(null);
  const [activeHandle, setActiveHandle] = useState<CaliperHandleId>('t2');
  const [paperSpeedMmPerSec, setPaperSpeedMmPerSec] = useState<25 | 50>(25);
  const [gainMmPerMv, setGainMmPerMv] = useState<5 | 10 | 20>(10);
  const [caliper, setCaliper] = useState<CaliperState>({
    t1Ms: 240,
    t2Ms: 1040,
    v1Mv: 0.0,
    v2Mv: 0.25,
  });

  const [prInput, setPrInput] = useState('');
  const [qrsInput, setQrsInput] = useState('');
  const [qtcInput, setQtcInput] = useState('');
  const [stInput, setStInput] = useState('');
  const [rhythmInput, setRhythmInput] = useState<RhythmClass>('NSR');
  const [formError, setFormError] = useState<string | null>(null);
  const [gradeReport, setGradeReport] = useState<CaliperGradeReport | null>(null);

  let resolvedRecord: PtbxlCaseRecord | null = null;
  try {
    resolvedRecord = getCaseById(dataset, caseId);
  } catch {
    resolvedRecord = null;
  }

  const isUnlocked = resolvedRecord !== null && canAccessCase(resolvedRecord);

  // Reset caliper handles deterministically when route :caseId changes (US-04.4)
  useEffect(() => {
    isDraggingRef.current = false;
    draggingHandleRef.current = null;
    setCaliper({ t1Ms: 240, t2Ms: 1040, v1Mv: 0.0, v2Mv: 0.25 });
    setPrInput('');
    setQrsInput('');
    setQtcInput('');
    setStInput('');
    setFormError(null);
    setGradeReport(null);
    setRhythmInput('NSR');
    onGradeUpdate?.(null, isUnlocked ? resolvedRecord : null);
  }, [caseId, isUnlocked]);

  const rawCaliperDeltaMs = Math.max(1, Math.abs(caliper.t2Ms - caliper.t1Ms));

  const metrics = computeCaliperMetrics(
    caliper.t1Ms,
    caliper.t2Ms,
    caliper.v1Mv,
    caliper.v2Mv,
    rawCaliperDeltaMs
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !resolvedRecord || !canAccessCase(resolvedRecord)) return;
    const ctx = getSafe2dContext(canvas);
    if (!ctx) return;

    const { width, height } = syncCanvasHiDpi(canvas, 960, 420, ctx);
    const waveforms = getCaseWaveforms(dataset, resolvedRecord.caseId, 5000);
    render12LeadCaliperCanvas(
      ctx,
      width,
      height,
      waveforms,
      caliper,
      metrics.marchingSpikesMs,
      gradeReport !== null,
      resolvedRecord,
      darkTheme,
      {
        paperSpeedMmPerSec,
        gainMmPerMv,
      }
    );
  }, [
    dataset,
    resolvedRecord,
    caliper,
    metrics.marchingSpikesMs,
    gradeReport,
    darkTheme,
    canAccessCase,
    paperSpeedMmPerSec,
    gainMmPerMv,
  ]);

  // Invalid Case ID Recovery Panel (US-04.3)
  if (!resolvedRecord) {
    return (
      <section class="tw-surface p-6 max-w-md flex flex-col gap-3">
        <h1 class="m-0">Case Record Not Found</h1>
        <p class="text-sm m-0 tw-text-muted">
          Strip identifier {caseId} is absent from the PTB-XL catalog. Load starter strip ptbxl-001.
        </p>
        <div>
          <button
            type="button"
            data-testid="recover-default-case-btn"
            onClick={() => onSelectCaseId('ptbxl-001')}
            class="tw-btn-primary"
          >
            Load Starter Strip
          </button>
        </div>
      </section>
    );
  }

  // Pro Exam Pass / Cohort Entitlement Gate for cases 025..120 (US-04.6)
  if (!canAccessCase(resolvedRecord)) {
    return (
      <section data-testid="pro-case-gate-panel" class="tw-surface p-6 max-w-xl flex flex-col gap-3">
        <h1 class="m-0">Pro Strip Locked ({resolvedRecord.caseId})</h1>
        <p class="text-sm m-0 tw-prose tw-text-muted">
          Starter strips ptbxl-001 to ptbxl-024 are free. Unlock all 120 PTB-XL strips with Pro Access or a cohort seed.
        </p>
        <div class="flex flex-wrap gap-3 mt-1">
          <button
            type="button"
            data-testid="unlock-pro-from-caliper-btn"
            onClick={onNavigateCohortUnlock}
            class="tw-btn-primary"
          >
            Unlock Pro Access
          </button>
          <button
            type="button"
            onClick={() => onSelectCaseId('ptbxl-001')}
            class="tw-btn-secondary"
          >
            Load Starter Strip
          </button>
        </div>
      </section>
    );
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown'
    ) {
      e.preventDefault();
      const maxDurationMs = paperSpeedMmPerSec === 50 ? 5000 : 10000;
      setCaliper((prev) => {
        const next = nudgeCaliperState(
          prev,
          activeHandle,
          e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
          e.shiftKey
        );
        return {
          ...next,
          t1Ms: activeHandle === 't1' ? Math.min(maxDurationMs, next.t1Ms) : next.t1Ms,
          t2Ms: activeHandle === 't2' ? Math.min(maxDurationMs, next.t2Ms) : next.t2Ms,
        };
      });
    }
  };

  const applyPointerCoordinate = (
    rawClientX: number,
    rawClientY: number,
    handleToMove: CaliperHandleId
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const clientX = Number.isFinite(rawClientX) ? rawClientX : 0;
    const clientY = Number.isFinite(rawClientY) ? rawClientY : 0;
    const rect = canvas.getBoundingClientRect();
    const effWidth = rect.width > 0 ? rect.width : canvas.width || 960;
    const effHeight = rect.height > 0 ? rect.height : canvas.height || 420;
    const geom = getCaliperStripGeometry(effWidth, effHeight, paperSpeedMmPerSec, gainMmPerMv);
    if (handleToMove === 't1' || handleToMove === 't2') {
      const clampedX = Math.max(0, Math.min(effWidth, clientX - rect.left));
      const rawMs = geom.xToMs(clampedX);
      const snappedMs = Math.max(
        0,
        Math.min(geom.visibleDurationMs, Math.round(rawMs / 2) * 2)
      );
      setCaliper((prev) =>
        handleToMove === 't1' ? { ...prev, t1Ms: snappedMs } : { ...prev, t2Ms: snappedMs }
      );
    } else {
      const yPx = clientY - rect.top;
      const rawMv = geom.yToMv(yPx);
      const clampedMv = Number(Math.max(-5.0, Math.min(5.0, rawMv)).toFixed(2));
      setCaliper((prev) =>
        handleToMove === 'v1' ? { ...prev, v1Mv: clampedMv } : { ...prev, v2Mv: clampedMv }
      );
    }
  };

  const handlePointerDown = (e: PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const effWidth = rect.width > 0 ? rect.width : canvas.width || 960;
    const effHeight = rect.height > 0 ? rect.height : canvas.height || 420;
    const clientX = Number.isFinite(e.clientX) ? e.clientX : 0;
    const clientY = Number.isFinite(e.clientY) ? e.clientY : 0;
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const hitHandle = hitTestCaliperHandle(
      localX,
      localY,
      effWidth,
      effHeight,
      caliper,
      activeHandle,
      gainMmPerMv,
      18,
      paperSpeedMmPerSec
    );

    isDraggingRef.current = true;
    draggingHandleRef.current = hitHandle;
    setActiveHandle(hitHandle);

    try {
      (e.currentTarget as HTMLCanvasElement | null)?.setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointerId
    }
    applyPointerCoordinate(e.clientX, e.clientY, hitHandle);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDraggingRef.current) return;
    applyPointerCoordinate(e.clientX, e.clientY, draggingHandleRef.current ?? activeHandle);
  };

  const handlePointerUpOrCancel = (e: PointerEvent) => {
    isDraggingRef.current = false;
    draggingHandleRef.current = null;
    try {
      (e.currentTarget as HTMLCanvasElement | null)?.releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignore synthetic events
    }
  };

  const handlePointerPlotClick = (e: MouseEvent) => {
    applyPointerCoordinate(e.clientX, e.clientY, activeHandle);
  };

  const handleAutofillFromFiducials = () => {
    setPrInput(String(Math.round(metrics.deltaMs)));
    setQrsInput(String(Math.round(metrics.deltaMs)));
    setQtcInput(String(Math.round(metrics.qtcMs)));
    setStInput(metrics.deltaMv.toFixed(2));
    setFormError(null);
  };

  const handleSubmitGrade = (e: Event) => {
    e.preventDefault();
    const prVal = Number(prInput);
    const qrsVal = Number(qrsInput);
    const qtcVal = Number(qtcInput);
    const stVal = Number(stInput);

    if (
      prInput.trim() === '' ||
      qrsInput.trim() === '' ||
      qtcInput.trim() === '' ||
      stInput.trim() === '' ||
      !Number.isFinite(prVal) ||
      !Number.isFinite(qrsVal) ||
      !Number.isFinite(qtcVal) ||
      !Number.isFinite(stVal)
    ) {
      setFormError('Enter finite numeric values for PR, QRS, QTc, and ST.');
      return;
    }

    setFormError(null);
    const report = gradeCaliperSubmission(resolvedRecord, {
      prMs: prVal,
      qrsMs: qrsVal,
      qtcMs: qtcVal,
      stMv: stVal,
      rhythmClass: rhythmInput,
    });
    setGradeReport(report);
    onGradeUpdate?.(report, resolvedRecord);
  };

  const baseOptions =
    filteredRecords && filteredRecords.length > 0 ? filteredRecords : dataset.records;
  const optionSet = new Set(baseOptions.map((r) => r.caseId));
  const switcherRecords = dataset.records.filter(
    (r) =>
      optionSet.has(r.caseId) ||
      r.caseId === resolvedRecord.caseId ||
      r.caseId === 'ptbxl-003' ||
      r.caseId === 'ptbxl-051'
  );

  return (
    <div class="flex flex-col gap-4">
      {/* Group 1: Header Strip & Case Switcher */}
      <section class="tw-surface px-4 py-3 flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="m-0">Diagnostic Strip Calipers</h1>
          <span
            data-testid="active-caliper-case-id"
            class="tw-mono-vital text-xs px-2 py-1 rounded tw-chip-muted"
          >
            {resolvedRecord.caseId} · {paperSpeedMmPerSec} mm/s · {gainMmPerMv} mm/mV
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          {/* Paper Speed Selector (25 / 50 mm/s) */}
          <div class="flex items-center gap-1" role="group" aria-label="ECG Paper Speed">
            <button
              type="button"
              data-testid="caliper-speed-25"
              onClick={() => setPaperSpeedMmPerSec(25)}
              class={paperSpeedMmPerSec === 25 ? 'tw-btn-primary tw-mono-vital' : 'tw-btn-secondary tw-mono-vital'}
            >
              25 mm/s
            </button>
            <button
              type="button"
              data-testid="caliper-speed-50"
              onClick={() => setPaperSpeedMmPerSec(50)}
              class={paperSpeedMmPerSec === 50 ? 'tw-btn-primary tw-mono-vital' : 'tw-btn-secondary tw-mono-vital'}
            >
              50 mm/s
            </button>
          </div>

          {/* Gain Selector (5 / 10 / 20 mm/mV) */}
          <div class="flex items-center gap-1" role="group" aria-label="ECG Amplitude Gain">
            {([5, 10, 20] as const).map((g) => (
              <button
                key={g}
                type="button"
                data-testid={`caliper-gain-${g}`}
                onClick={() => setGainMmPerMv(g)}
                class={gainMmPerMv === g ? 'tw-btn-primary tw-mono-vital' : 'tw-btn-secondary tw-mono-vital'}
              >
                {g} mm/mV
              </button>
            ))}
          </div>

          <div class="flex items-center gap-2">
            <label htmlFor="caliper-case-switcher" class="text-sm font-medium w-fit">
              PTB-XL Strip:
            </label>
            <select
              id="caliper-case-switcher"
              name="caseSwitcher"
              data-testid="caliper-case-switcher"
              value={resolvedRecord.caseId}
              onChange={(e) => onSelectCaseId((e.target as HTMLSelectElement).value)}
              class="tw-btn-secondary"
            >
              {switcherRecords.map((r) => {
                const unlocked = canAccessCase(r);
                return (
                  <option key={r.caseId} value={r.caseId}>
                    {r.caseId} {unlocked ? `(${r.rhythmClass})` : '(Pro Exam Strip — Locked)'}{' '}
                    {r.freeStarter ? '· Free' : '· Pro'}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </section>

      {/* Group 2: Interactive Caliper Toolbar & 12-Lead Paper Grid */}
      <section class="tw-surface p-4 flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b tw-border">
          <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Active Caliper Handle Selector">
            {(['t1', 't2', 'v1', 'v2'] as const).map((h) => (
              <button
                key={h}
                type="button"
                data-testid={`caliper-handle-btn-${h}`}
                onClick={() => setActiveHandle(h)}
                class={activeHandle === h ? 'tw-btn-primary' : 'tw-btn-secondary'}
              >
                Handle {h.toUpperCase()}
              </button>
            ))}
          </div>

          <div class="flex flex-wrap items-center gap-4 text-sm">
            <span>
              T1: <strong data-testid="caliper-t1-ms" class="tw-mono-vital">{caliper.t1Ms} ms</strong>
            </span>
            <span>
              T2: <strong data-testid="caliper-t2-ms" class="tw-mono-vital">{caliper.t2Ms} ms</strong>
            </span>
            <span>
              Δt: <strong class="tw-mono-vital">{metrics.deltaMs} ms ({metrics.hrDisplay})</strong>
            </span>
            <span>
              Bazett QTc: <strong class="tw-mono-vital">{metrics.qtcMs} ms</strong>
            </span>
            <span>
              V1: <strong data-testid="caliper-v1-mv" class="tw-mono-vital">{caliper.v1Mv} mV</strong>
            </span>
            <span>
              V2: <strong data-testid="caliper-v2-mv" class="tw-mono-vital">{caliper.v2Mv} mV</strong>
            </span>
            <span>
              ΔV: <strong class="tw-mono-vital">{metrics.deltaMv} mV</strong>
            </span>
          </div>
        </div>

        <canvas
          ref={canvasRef}
          data-testid="caliper-12lead-canvas"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onClick={handlePointerPlotClick}
          width={960}
          height={420}
          class="w-full rounded cursor-crosshair tw-canvas-frame"
          style={{ touchAction: 'none' }}
          aria-label={`12-lead ECG strip for ${resolvedRecord.caseId} at ${paperSpeedMmPerSec} mm/s and ${gainMmPerMv} mm/mV`}
        />
      </section>

      {/* Group 3: Interval Adjudication Dock */}
      <section class="tw-surface p-4">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-3 border-b tw-border">
          <h2 class="m-0">Interval Adjudication</h2>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPrInput(String(Math.round(metrics.deltaMs)));
                setFormError(null);
              }}
              class="tw-btn-secondary text-sm"
            >
              Set PR
            </button>
            <button
              type="button"
              onClick={() => {
                setQrsInput(String(Math.round(metrics.deltaMs)));
                setFormError(null);
              }}
              class="tw-btn-secondary text-sm"
            >
              Set QRS
            </button>
            <button
              type="button"
              data-testid="autofill-caliper-fiducials-btn"
              onClick={handleAutofillFromFiducials}
              class="tw-btn-secondary text-sm"
            >
              Apply Calipers
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmitGrade} class="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div>
            <label htmlFor="input-pr-ms" class="block text-sm font-medium mb-1 w-fit">
              PR Interval (ms) *
            </label>
            <input
              id="input-pr-ms"
              name="prMs"
              type="text"
              inputMode="numeric"
              autocomplete="off"
              value={prInput}
              onInput={(e) => setPrInput((e.target as HTMLInputElement).value)}
              class="w-full h-10 px-3 rounded tw-mono-vital text-sm tw-input"
            />
          </div>

          <div>
            <label htmlFor="input-qrs-ms" class="block text-sm font-medium mb-1 w-fit">
              QRS Duration (ms) *
            </label>
            <input
              id="input-qrs-ms"
              name="qrsMs"
              type="text"
              inputMode="numeric"
              autocomplete="off"
              value={qrsInput}
              onInput={(e) => setQrsInput((e.target as HTMLInputElement).value)}
              class="w-full h-10 px-3 rounded tw-mono-vital text-sm tw-input"
            />
          </div>

          <div>
            <label htmlFor="input-qtc-ms" class="block text-sm font-medium mb-1 w-fit">
              Bazett QTc (ms) *
            </label>
            <input
              id="input-qtc-ms"
              name="qtcMs"
              type="text"
              inputMode="numeric"
              autocomplete="off"
              value={qtcInput}
              onInput={(e) => setQtcInput((e.target as HTMLInputElement).value)}
              class="w-full h-10 px-3 rounded tw-mono-vital text-sm tw-input"
            />
          </div>

          <div>
            <label htmlFor="input-st-mv" class="block text-sm font-medium mb-1 w-fit">
              J-Point ST (mV) *
            </label>
            <input
              id="input-st-mv"
              name="stMv"
              type="text"
              inputMode="decimal"
              autocomplete="off"
              value={stInput}
              onInput={(e) => setStInput((e.target as HTMLInputElement).value)}
              class="w-full h-10 px-3 rounded tw-mono-vital text-sm tw-input"
            />
          </div>

          <div>
            <label htmlFor="select-rhythm-class" class="block text-sm font-medium mb-1 w-fit">
              Rhythm Class *
            </label>
            <select
              id="select-rhythm-class"
              name="rhythmClass"
              value={rhythmInput}
              onChange={(e) => setRhythmInput((e.target as HTMLSelectElement).value as RhythmClass)}
              class="w-full h-10 px-3 rounded text-sm tw-input"
            >
              {RHYTHM_CLASSES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" data-testid="submit-caliper-grade-btn" class="tw-btn-primary">
            Grade Strip
          </button>
        </form>

        {formError ? (
          <p data-testid="caliper-form-error" class="mt-3 mb-0 text-sm tw-text-abp">
            {formError}
          </p>
        ) : null}

        {gradeReport ? (
          <div data-testid="caliper-grade-result" class="mt-4 pt-3 border-t text-sm tw-border">
            <strong>{gradeReport.overallPass ? 'OVERALL PASS' : 'NEEDS REVIEW'}</strong> · Ground Truth:{' '}
            <span class="tw-mono-vital">
              PR {resolvedRecord.fiducials.prMs} ms ({gradeReport.prPass ? 'PASS' : 'FAIL'}) · QRS{' '}
              {resolvedRecord.fiducials.qrsMs} ms ({gradeReport.qrsPass ? 'PASS' : 'FAIL'}) · QTc{' '}
              {resolvedRecord.fiducials.qtcMs} ms ({gradeReport.qtcPass ? 'PASS' : 'FAIL'}) · ST{' '}
              {resolvedRecord.fiducials.stMv} mV ({gradeReport.stPass ? 'PASS' : 'FAIL'}) ·{' '}
              {resolvedRecord.rhythmClass}
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
