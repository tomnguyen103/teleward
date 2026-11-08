import { describe, it, expect } from 'vitest';
import {
  TelemetryRingBuffer,
  stepTelemetryFrame,
  synthesizeRealtimeSample,
  createInitialVitals,
} from '../src/engine/physiology.ts';
import { runSimulation, ShiftController } from '../src/engine/aclsEngine.ts';

describe('Ticket 01: Continuous-Phase Cardiac Synthesis & Coupled Hemodynamics', () => {
  it('US-02.3: integrates continuous cardiac and respiratory phase in TelemetryRingBuffer so SVT (188 bpm) -> NSR (74 bpm) conversion never jumps vertically', () => {
    const ring = new TelemetryRingBuffer(2500, 90);
    const svtVitals = createInitialVitals('SVT');
    ring.prefill(svtVitals, 1250);

    const phaseBefore = ring.ecgPhase;
    expect(phaseBefore).toBeGreaterThanOrEqual(0);
    expect(phaseBefore).toBeLessThan(1);

    const lastSvtIdx = (ring.writeCursor - 1 + ring.capacity) % ring.capacity;
    const lastSvtEcg = ring.ecg[lastSvtIdx]!;
    const lastSvtAbp = ring.abp[lastSvtIdx]!;

    // Convert immediately to NSR (74 bpm) at t = 2.5s and step 1 sample (2 ms)
    const nsrVitals = createInitialVitals('NSR');
    const stepRes = stepTelemetryFrame(ring, nsrVitals, 2);
    expect(stepRes.samplesWritten).toBe(1);

    const firstNsrIdx = (ring.writeCursor - 1 + ring.capacity) % ring.capacity;
    const firstNsrEcg = ring.ecg[firstNsrIdx]!;
    const firstNsrAbp = ring.abp[firstNsrIdx]!;

    // Phase advances smoothly by (74 / 60) * 0.002 = ~0.002467 cycles without phase-wrap discontinuity
    const expectedPhaseIncrement = ((74 / 60) * 0.002) % 1;
    const actualPhaseDelta = (ring.ecgPhase - phaseBefore + 1) % 1;
    expect(Math.abs(actualPhaseDelta - expectedPhaseIncrement)).toBeLessThan(1e-5);

    // Adjacent 2ms samples across the HR change must not jump vertically
    expect(Math.abs(firstNsrEcg - lastSvtEcg)).toBeLessThan(0.25);
    expect(Math.abs(firstNsrAbp - lastSvtAbp)).toBeLessThan(35);
  });

  it('US-01.2 & US-02.3: preserves deterministic RK4 ACLS trajectories and multi-bed isolation', () => {
    const simA = runSimulation({
      scenario: 'VFIB',
      intervention: 'defibrillation',
      atSec: 6,
      durationSec: 30,
      seed: 42,
    });
    const simB = runSimulation({
      scenario: 'VFIB',
      intervention: 'defibrillation',
      atSec: 6,
      durationSec: 30,
      seed: 42,
    });
    expect(simA).toEqual(simB);
    expect(simA.outcome).toBe('STABILIZED');
    expect(simA.finalVitals.rhythm).toBe('NSR');

    const sample = synthesizeRealtimeSample(simA.finalVitals, 2.0, {
      ecgPhase: 0.35,
      respPhase: 0.4,
    });
    expect(sample.ecgMv).toBeGreaterThan(0.8); // R-wave peak at phase 0.35
    expect(sample.etco2MmHg).toBeGreaterThan(25); // Alveolar plateau at respPhase 0.4

    const shift = new ShiftController(42);
    shift.stepSeconds(4);
    expect(shift.getBeds().length).toBe(4);

    // Stepping 300s into unrescued arrest must clamp HR, SBP, DBP, and RR at 0 with zero PRNG jitter drift
    for (let i = 0; i < 30; i++) {
      shift.stepSeconds(10);
    }
    for (const bed of shift.getBeds()) {
      expect(bed.arrested).toBe(true);
      expect(bed.vitals.rhythm).toBe('ASYSTOLE');
      expect(bed.vitals.hr).toBe(0);
      expect(bed.vitals.sbp).toBe(0);
      expect(bed.vitals.dbp).toBe(0);
      expect(bed.vitals.rr).toBe(0);
    }

    // After a prohibited unsynchronized shock induces VFIB, advancing the shift keeps VFIB shockable until defibrillated
    const rescueShift = new ShiftController(42);
    const nonVfibBed = rescueShift.getBeds().find((b) => b.vitals.rhythm === 'SVT' || b.vitals.rhythm === 'AFIB') ?? rescueShift.getBeds()[1]!;
    rescueShift.applyIntervention(nonVfibBed.bedIndex, 'defibrillation', 1000);
    expect(rescueShift.getBeds()[nonVfibBed.bedIndex]!.vitals.rhythm).toBe('VFIB');
    expect(rescueShift.getBeds()[nonVfibBed.bedIndex]!.arrested).toBe(true);
    rescueShift.stepSeconds(4);
    expect(rescueShift.getBeds()[nonVfibBed.bedIndex]!.vitals.rhythm).toBe('VFIB');
    rescueShift.applyIntervention(nonVfibBed.bedIndex, 'defibrillation', 2000);
    expect(rescueShift.getBeds()[nonVfibBed.bedIndex]!.vitals.rhythm).toBe('NSR');
  });

  it('v2.0 Audit (F-09 & F-10): unifies isBedStabilized hemodynamic criteria, clamps ShiftController at 300s, and supports npx teleward simulate --seed 42 --json', async () => {
    const { isBedStabilized, SHIFT_DURATION_SEC } = await import('../src/engine/aclsEngine.ts');
    const { executeCli } = await import('../src/cli/teleward.ts');

    // Hypotensive NSR (SBP 50, MAP 40) must NOT be marked stabilized
    const hypotensiveNsr = {
      ...createInitialVitals('NSR'),
      sbp: 50,
      dbp: 35,
      map: 40,
      spo2: 96,
      etco2: 38,
    };
    expect(isBedStabilized(hypotensiveNsr, true, [])).toBe(false);

    // Normotensive NSR without AHA violations is stabilized
    const normotensiveNsr = {
      ...createInitialVitals('NSR'),
      sbp: 118,
      dbp: 76,
      map: 90,
      spo2: 98,
      etco2: 38,
    };
    expect(isBedStabilized(normotensiveNsr, true, [])).toBe(true);

    // Normotensive NSR with prior AHA violation is NOT stabilized
    expect(isBedStabilized(normotensiveNsr, true, ['AHA_UNSYNC_SHOCK_ON_PERFUSING'])).toBe(false);

    // Paced AVB3 with normotension is stabilized
    const pacedAvb3 = {
      ...createInitialVitals('AVB3'),
      paced: true,
      hr: 70,
      sbp: 108,
      dbp: 68,
      map: 81,
      spo2: 96,
      etco2: 37,
    };
    expect(isBedStabilized(pacedAvb3, true, [])).toBe(true);

    // 300s shift horizon clamp
    expect(SHIFT_DURATION_SEC).toBe(300);
    const shift = new ShiftController(42);
    expect(shift.isShiftComplete()).toBe(false);
    for (let i = 0; i < 35; i++) {
      shift.stepSeconds(10);
    }
    expect(shift.getElapsedSec()).toBe(300);
    expect(shift.isShiftComplete()).toBe(true);

    // CLI simulate subcommand alias
    let cliStdout = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      cliStdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const cliCode = executeCli(['simulate', '--seed', '42', '--json']);
      expect(cliCode).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const parsed = JSON.parse(cliStdout) as {
      numericSeed: number;
      elapsedSec: number;
      beds: Array<{ stabilized: boolean }>;
    };
    expect(parsed.numericSeed).toBe(42);
    expect(parsed.elapsedSec).toBe(300);
    expect(parsed.beds.length).toBe(4);

    // Bed with an AHA violation cannot be counted as stabilized even after subsequent conversion
    const violCtrl = new ShiftController(42);
    violCtrl.applyIntervention(0, 'adenosine_6mg', 1000);
    violCtrl.applyIntervention(0, 'defibrillation', 2000);
    expect(violCtrl.getBeds()[0]?.ahaViolations.length).toBeGreaterThan(0);
    expect(violCtrl.getBeds()[0]?.stabilized).toBe(false);
    expect(violCtrl.computeShiftScore().bedsStabilized).toBe(0);
  });
});
