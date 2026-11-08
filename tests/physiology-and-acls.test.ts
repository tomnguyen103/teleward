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
  });
});

