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
  getSafe2dContext,
  render12LeadCaliperCanvas,
} from '../canvas/TelemetryCanvas.ts';

export interface CaliperViewProps {
  dataset: LoadedPtbxlDataset;
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
    caseId,
    onSelectCaseId,
    canAccessCase,
    onNavigateCohortUnlock,
    darkTheme,
    onGradeUpdate,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef(false);
  const [activeHandle, setActiveHandle] = useState<'t1' | 't2' | 'v1' | 'v2'>('t2');
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
    setCaliper({ t1Ms: 240, t2Ms: 1040, v1Mv: 0.0, v2Mv: 0.25 });
    setFormError(null);
    setGradeReport(null);
    setRhythmInput('NSR');
    onGradeUpdate?.(null, isUnlocked ? resolvedRecord : null);
  }, [caseId, isUnlocked]);

  const metrics = computeCaliperMetrics(
    caliper.t1Ms,
    caliper.t2Ms,
    caliper.v1Mv,
    caliper.v2Mv,
    isUnlocked && resolvedRecord ? resolvedRecord.fiducials.qtMs : 380
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !resolvedRecord || !canAccessCase(resolvedRecord)) return;
    const ctx = getSafe2dContext(canvas);
    if (!ctx) return;

    const waveforms = getCaseWaveforms(dataset, resolvedRecord.caseId, 5000);
    render12LeadCaliperCanvas(
      ctx,
      canvas.width,
      canvas.height,
      waveforms,
      caliper,
      metrics.marchingSpikesMs,
      gradeReport !== null,
      resolvedRecord,
      darkTheme
    );
  }, [dataset, resolvedRecord, caliper, metrics.marchingSpikesMs, gradeReport, darkTheme, canAccessCase]);

  // Invalid Case ID Recovery Panel (US-04.3)
  if (!resolvedRecord) {
    return (
      <section class="tw-surface p-6 max-w-md">
        <h1>PTB-XL Case Record Not Found</h1>
        <p class="text-sm" style={{ color: 'var(--text-muted)' }}>
          The requested 12-lead ECG strip identifier ({caseId}) does not exist in the compiled 120-record PTB-XL index.
        </p>
        <button
          type="button"
          data-testid="recover-default-case-btn"
          onClick={() => onSelectCaseId('ptbxl-001')}
          class="tw-btn-primary mt-2"
        >
          Load Starter Case (ptbxl-001)
        </button>
      </section>
    );
  }

  // Pro Exam Pass / Cohort Entitlement Gate for cases 025..120 (US-04.6)
  if (!canAccessCase(resolvedRecord)) {
    return (
      <section data-testid="pro-case-gate-panel" class="tw-surface p-6 max-w-xl">
        <h1>Pro Exam Bank Record Locked ({resolvedRecord.caseId})</h1>
        <p class="text-sm tw-prose" style={{ color: 'var(--text-muted)' }}>
          Starter cases ptbxl-001 through ptbxl-024 (2 per rhythm class) are free. Unlock all 120 cardiologist-annotated PTB-XL records with the Pro Exam Pass ($19) or enter an active instructor ?cohort= seed.
        </p>
        <div class="flex flex-wrap gap-3 mt-4">
          <button
            type="button"
            data-testid="unlock-pro-from-caliper-btn"
            onClick={onNavigateCohortUnlock}
            class="tw-btn-primary"
          >
            Unlock Pro Exam Pass ($19) or Enter Cohort Seed
          </button>
          <button
            type="button"
            onClick={() => onSelectCaseId('ptbxl-001')}
            class="tw-btn-secondary"
          >
            Return to Free Starter Strip (ptbxl-001)
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
      setCaliper((prev) =>
        nudgeCaliperState(
          prev,
          activeHandle,
          e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
          e.shiftKey
        )
      );
    }
  };

  const applyPointerCoordinate = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const effWidth = rect.width > 0 ? rect.width : canvas.width || 960;
    const effHeight = rect.height > 0 ? rect.height : canvas.height || 420;
    if (activeHandle === 't1' || activeHandle === 't2') {
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / effWidth));
      const snappedMs = Math.max(0, Math.min(10000, Math.round((relX * 10000) / 2) * 2));
      setCaliper((prev) =>
        activeHandle === 't1' ? { ...prev, t1Ms: snappedMs } : { ...prev, t2Ms: snappedMs }
      );
    } else {
      const relY = Math.max(0, Math.min(1, (clientY - rect.top) / effHeight));
      const rawMv = (0.5 - relY) * 5.0;
      const clampedMv = Number(Math.max(-5.0, Math.min(5.0, rawMv)).toFixed(2));
      setCaliper((prev) =>
        activeHandle === 'v1' ? { ...prev, v1Mv: clampedMv } : { ...prev, v2Mv: clampedMv }
      );
    }
  };

  const handlePointerDown = (e: PointerEvent) => {
    isDraggingRef.current = true;
    applyPointerCoordinate(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDraggingRef.current) return;
    applyPointerCoordinate(e.clientX, e.clientY);
  };

  const handlePointerUpOrCancel = () => {
    isDraggingRef.current = false;
  };

  const handlePointerPlotClick = (e: MouseEvent) => {
    applyPointerCoordinate(e.clientX, e.clientY);
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
      setFormError('Enter finite numeric values for PR (ms), QRS (ms), Bazett QTc (ms), and ST deviation (mV).');
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

  return (
    <div class="flex flex-col gap-4">
      {/* Header & Case Switcher */}
      <section class="tw-surface p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1>
            12-Lead Digital Marching Calipers ·{' '}
            <span data-testid="active-caliper-case-id" class="tw-mono-vital">
              {resolvedRecord.caseId}
            </span>
          </h1>
          <p class="text-sm m-0" style={{ color: 'var(--text-muted)' }}>
            25 mm/s · 10 mm/mV calibration · Patient {resolvedRecord.age}
            {resolvedRecord.sex} · SCP-ECG Record #{resolvedRecord.ptbxlRecordId}
          </p>
        </div>

        <div class="flex items-center gap-3">
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
            {dataset.records.map((r) => {
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
      </section>

      {/* Interactive Caliper Toolbar & 12-Lead Paper Grid */}
      <section class="tw-surface p-4 flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
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
          class="w-full rounded border cursor-crosshair"
          style={{ borderColor: 'var(--border)' }}
          aria-label={`12-lead ECG strip for ${resolvedRecord.caseId}. Use Arrow keys to nudge caliper handles by 2 ms or 0.05 mV, Shift+Arrow for 20 ms.`}
        />
      </section>

      {/* Measurement & Fiducial Grading Form */}
      <section class="tw-surface p-4">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 class="m-0">Grade 12-Lead Interval Measurements Against PTB-XL Fiducials</h2>
          <button
            type="button"
            data-testid="autofill-caliper-fiducials-btn"
            onClick={handleAutofillFromFiducials}
            class="tw-btn-secondary text-sm"
          >
            Load Caliper Readings into Form
          </button>
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
              class="w-full h-10 px-3 rounded border tw-mono-vital text-sm"
              style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text)' }}
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
              class="w-full h-10 px-3 rounded border tw-mono-vital text-sm"
              style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text)' }}
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
              class="w-full h-10 px-3 rounded border tw-mono-vital text-sm"
              style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text)' }}
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
              class="w-full h-10 px-3 rounded border tw-mono-vital text-sm"
              style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
          </div>

          <div>
            <label htmlFor="select-rhythm-class" class="block text-sm font-medium mb-1 w-fit">
              Rhythm Diagnosis *
            </label>
            <select
              id="select-rhythm-class"
              name="rhythmClass"
              value={rhythmInput}
              onChange={(e) => setRhythmInput((e.target as HTMLSelectElement).value as RhythmClass)}
              class="w-full h-10 px-3 rounded border text-sm"
              style={{ backgroundColor: 'var(--surface-muted)', borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              {RHYTHM_CLASSES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" data-testid="submit-caliper-grade-btn" class="tw-btn-primary">
            Grade 12-Lead Strip
          </button>
        </form>

        {formError ? (
          <p data-testid="caliper-form-error" class="mt-3 mb-0 text-sm" style={{ color: 'var(--trace-abp)' }}>
            {formError}
          </p>
        ) : null}

        {gradeReport ? (
          <div data-testid="caliper-grade-result" class="mt-4 pt-3 border-t text-sm" style={{ borderColor: 'var(--border)' }}>
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
