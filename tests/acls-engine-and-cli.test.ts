import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  runSimulation,
  ShiftController,
  validateSimulationOptions,
} from '../src/engine/aclsEngine.ts';
import { fnv1a32, mulberry32 } from '../src/engine/prng.ts';
import { synthesizeRealtimeSample } from '../src/engine/physiology.ts';
import type { SimulationResult, Rfc7807Error } from '../src/types/teleward.ts';

const WORKSPACE_ROOT = resolve(process.cwd());
const CLI_BIN = resolve(WORKSPACE_ROOT, 'bin/teleward.mjs');

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI_BIN, ...args], {
      cwd: WORKSPACE_ROOT,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

describe('US-02: Deterministic Coupled Cardiopulmonary & ACLS State Engine + CLI (npx teleward sim)', () => {
  it('US-02.1: converts TORSADES with magnesium_2g to NSR (STABILIZED) and flags amiodarone_300mg with AHA_TORSADES_AMIODARONE_CONTRAINDICATED', () => {
    const magRes = runCli([
      'sim',
      '--scenario',
      'torsades',
      '--intervention',
      'magnesium_2g',
      '--at',
      '10',
      '--duration',
      '45',
      '--seed',
      '42',
      '--json',
    ]);
    expect(magRes.status).toBe(0);
    const magJson = JSON.parse(magRes.stdout) as SimulationResult;
    expect(magJson.outcome).toBe('STABILIZED');
    expect(magJson.finalVitals.rhythm).toBe('NSR');
    expect(magJson.finalVitals.sbp).toBeGreaterThanOrEqual(100);
    expect(magJson.finalVitals.etco2).toBeGreaterThanOrEqual(35);
    expect(magJson.ahaViolations).toEqual([]);

    const amioRes = runCli([
      'sim',
      '--scenario',
      'torsades',
      '--intervention',
      'amiodarone_300mg',
      '--seed',
      '42',
      '--json',
    ]);
    expect(amioRes.status).toBe(0);
    const amioJson = JSON.parse(amioRes.stdout) as SimulationResult;
    expect(amioJson.ahaViolations).toContain('AHA_TORSADES_AMIODARONE_CONTRAINDICATED');
    expect(['ARREST', 'DETERIORATED']).toContain(amioJson.outcome);

    // Verify additional ACLS rescues across rhythm classes
    expect(
      runSimulation({ scenario: 'SVT', intervention: 'adenosine_6mg', atSec: 8, durationSec: 30, seed: 42 }).outcome
    ).toBe('STABILIZED');
    expect(
      runSimulation({ scenario: 'SB', intervention: 'atropine_1mg', atSec: 8, durationSec: 30, seed: 42 }).outcome
    ).toBe('STABILIZED');
    const avb3Paced = runSimulation({
      scenario: 'AVB3',
      intervention: 'transcutaneous_pacing',
      atSec: 8,
      durationSec: 30,
      seed: 42,
    });
    expect(avb3Paced.outcome).toBe('STABILIZED');
    expect(avb3Paced.finalVitals.paced).toBe(true);
    expect(avb3Paced.finalVitals.hr).toBe(70);

    const avb3UnsyncShock = runSimulation({
      scenario: 'AVB3',
      intervention: 'defibrillation',
      atSec: 5,
      durationSec: 25,
      seed: 42,
    });
    expect(avb3UnsyncShock.ahaViolations).toContain('AHA_UNSYNC_SHOCK_ON_PERFUSING');
    expect(avb3UnsyncShock.finalVitals.rhythm).toBe('VFIB');
    expect(
      runSimulation({
        scenario: 'AFIB',
        intervention: 'sync_cardioversion',
        atSec: 8,
        durationSec: 30,
        seed: 42,
      }).outcome
    ).toBe('STABILIZED');
    expect(
      runSimulation({ scenario: 'VFIB', intervention: 'defibrillation', atSec: 6, durationSec: 30, seed: 42 }).outcome
    ).toBe('STABILIZED');
    expect(
      runSimulation({
        scenario: 'ASYSTOLE',
        intervention: 'epinephrine_1mg',
        atSec: 6,
        durationSec: 30,
        seed: 42,
      }).outcome
    ).toBe('STABILIZED');
  });

  it('US-02.2: enforces physiological bounds at duration (1..3600s), intervention timing (at=0), and seed (0..UINT32_MAX) boundaries', () => {
    const boundaries = [
      { scenario: 'SVT', intervention: 'adenosine_6mg', atSec: 0, durationSec: 1, seed: 0 },
      { scenario: 'NSR', intervention: null, atSec: 0, durationSec: 3600, seed: 4294967295 },
    ] as const;

    for (const opts of boundaries) {
      const result = runSimulation(opts);
      for (const pt of result.trajectory) {
        const v = pt.vitals;
        expect(Number.isFinite(v.hr)).toBe(true);
        expect(v.hr).toBeGreaterThanOrEqual(0);
        expect(v.hr).toBeLessThanOrEqual(320);

        expect(Number.isFinite(v.sbp)).toBe(true);
        expect(v.sbp).toBeGreaterThanOrEqual(0);
        expect(v.sbp).toBeLessThanOrEqual(260);

        expect(Number.isFinite(v.dbp)).toBe(true);
        expect(v.dbp).toBeGreaterThanOrEqual(0);
        expect(v.dbp).toBeLessThanOrEqual(160);

        expect(Number.isFinite(v.spo2)).toBe(true);
        expect(v.spo2).toBeGreaterThanOrEqual(0);
        expect(v.spo2).toBeLessThanOrEqual(100);

        expect(Number.isFinite(v.etco2)).toBe(true);
        expect(v.etco2).toBeGreaterThanOrEqual(0);
        expect(v.etco2).toBeLessThanOrEqual(80);
      }
    }

    const waveSample = synthesizeRealtimeSample(
      { rhythm: 'NSR', hr: 75, sbp: 120, dbp: 80, map: 93, spo2: 98, etco2: 38, rr: 16, paced: false },
      1.25
    );
    expect(Number.isFinite(waveSample.ecgMv)).toBe(true);
    expect(Number.isFinite(waveSample.abpMmHg)).toBe(true);
    expect(Number.isFinite(waveSample.spo2Wave)).toBe(true);
    expect(Number.isFinite(waveSample.etco2MmHg)).toBe(true);

    const atZeroRescue = runSimulation({
      scenario: 'VFIB',
      intervention: 'defibrillation',
      atSec: 0,
      durationSec: 20,
      seed: 42,
    });
    expect(atZeroRescue.outcome).toBe('STABILIZED');
    const defibEv = atZeroRescue.causalTimeline.find((e) => e.action === 'defibrillation');
    expect(defibEv).toBeTruthy();
    expect(defibEv?.timeSec).toBe(0);

    const shortUntreated = runSimulation({
      scenario: 'NSR',
      intervention: null,
      durationSec: 5,
      seed: 42,
    });
    expect(shortUntreated.durationSec).toBe(5);
  });

  it('US-02.3: exits with code 2 and RFC 7807 JSON (status 422) on invalid scenario, intervention, duration, or seed flags', () => {
    const invalidInvocations = [
      ['sim', '--scenario', 'unknown_rhythm', '--seed', '42', '--json'],
      ['sim', '--scenario', 'vfib', '--intervention', 'invalid_drug', '--seed', '42', '--json'],
      ['sim', '--scenario', 'vfib', '--duration', '-5', '--seed', '42', '--json'],
      ['sim', '--scenario', 'vfib', '--duration', '99999', '--seed', '42', '--json'],
      ['sim', '--scenario', 'vfib', '--at', '', '--seed', '42', '--json'],
      ['sim', '--scenario', 'vfib', '--duration', '   ', '--seed', '42', '--json'],
      ['sim', '--scenario', 'vfib', '--seed', 'abc', '--json'],
      ['sim', '--scenario', 'vfib', '--intervention', '--json'],
    ];

    for (const args of invalidInvocations) {
      const res = runCli(args);
      expect(res.status).toBe(2);
      const output = (res.stdout || res.stderr).trim();
      const parsed = JSON.parse(output) as Rfc7807Error;
      expect(parsed.status).toBe(422);
      expect(parsed.type).toContain('https://teleward.clinic/errors/');
      expect(typeof parsed.title).toBe('string');
      expect(typeof parsed.detail).toBe('string');
    }

    expect(() =>
      validateSimulationOptions({ scenario: 'bad', seed: 42 })
    ).toThrow();
  });

  it('US-02.4: isolates 4 parallel ICU beds in ShiftController and produces byte-identical trajectories on repeated seeded runs', () => {
    const runA = JSON.stringify(
      runSimulation({ scenario: 'VFIB', intervention: 'defibrillation', atSec: 10, durationSec: 40, seed: 42 })
    );
    const runB = JSON.stringify(
      runSimulation({ scenario: 'VFIB', intervention: 'defibrillation', atSec: 10, durationSec: 40, seed: 42 })
    );
    expect(runA).toBe(runB);

    const shift1 = new ShiftController(fnv1a32('NURS402-FALL26'));
    const shift2 = new ShiftController(fnv1a32('NURS402-FALL26'));

    shift1.stepSeconds(5.0);
    shift2.stepSeconds(5.0);

    expect(JSON.stringify(shift1.getBeds())).toBe(JSON.stringify(shift2.getBeds()));

    // Intervening on Bed 1 must not mutate Bed 2, 3, or 4
    const bed2Before = JSON.stringify(shift1.getBeds()[1]?.vitals);
    const bed1Rhythm = shift1.getBeds()[0]!.vitals.rhythm;
    const actionForBed1 = bed1Rhythm === 'VFIB' ? 'defibrillation' : 'epinephrine_1mg';
    shift1.applyIntervention(0, actionForBed1);
    const bed2After = JSON.stringify(shift1.getBeds()[1]?.vitals);
    expect(bed2After).toBe(bed2Before);

    const r1 = mulberry32(12345)();
    const r2 = mulberry32(12345)();
    expect(r1).toBe(r2);
  });

  it('US-02.5: collapses ABP toward 0/0 mmHg within 12s and EtCO2 < 10 mmHg on untreated VFIB or mistreated NSR + defibrillation', () => {
    const untreatedVfib = runSimulation({
      scenario: 'VFIB',
      intervention: null,
      durationSec: 25,
      seed: 42,
    });
    expect(untreatedVfib.outcome).toBe('ARREST');
    const at12s = untreatedVfib.trajectory.find((p) => p.timeSec >= 12)!;
    expect(at12s.vitals.sbp).toBeLessThanOrEqual(15);
    expect(untreatedVfib.finalVitals.sbp).toBeLessThanOrEqual(5);
    expect(untreatedVfib.finalVitals.etco2).toBeLessThan(10);

    const mistreatedNsr = runSimulation({
      scenario: 'NSR',
      intervention: 'defibrillation',
      atSec: 5,
      durationSec: 30,
      seed: 42,
    });
    expect(mistreatedNsr.outcome).toBe('ARREST');
    expect(mistreatedNsr.finalVitals.rhythm).toBe('VFIB');
    expect(mistreatedNsr.ahaViolations).toContain('AHA_UNSYNC_SHOCK_ON_PERFUSING');
    expect(mistreatedNsr.finalVitals.sbp).toBeLessThanOrEqual(5);
    expect(mistreatedNsr.finalVitals.etco2).toBeLessThan(10);

    const shockAsystole = runSimulation({
      scenario: 'ASYSTOLE',
      intervention: 'defibrillation',
      atSec: 5,
      durationSec: 25,
      seed: 42,
    });
    expect(shockAsystole.outcome).toBe('ARREST');
    expect(shockAsystole.ahaViolations).toContain('AHA_SHOCK_NON_SHOCKABLE');

    const avb3Atropine = runSimulation({
      scenario: 'AVB3',
      intervention: 'atropine_1mg',
      atSec: 5,
      durationSec: 25,
      seed: 42,
    });
    expect(avb3Atropine.ahaViolations).toContain('AHA_AVB3_ATROPINE_INEFFECTIVE');

    // Verify CRISIS alarm retention across stepSeconds() after an AHA violation & ISCHEMIC_ARREST event on countdown expiry
    const shift = new ShiftController(42);
    const avb3BedIdx = shift.getBeds().findIndex((b) => b.vitals.rhythm === 'AVB3' || b.vitals.rhythm === 'SVT');
    const targetIdx = avb3BedIdx >= 0 ? avb3BedIdx : 0;
    const wrongAction =
      shift.getBeds()[targetIdx]!.vitals.rhythm === 'AVB3' ? 'atropine_1mg' : 'defibrillation';
    shift.applyIntervention(targetIdx, wrongAction, 0);
    expect(shift.getBeds()[targetIdx]!.ahaViolations.length).toBeGreaterThan(0);
    expect(shift.getBeds()[targetIdx]!.alarmPriority).toBe('CRISIS');

    // Step forward and confirm CRISIS alarm is retained even if rhythm would otherwise be WARNING
    shift.stepSeconds(5);
    expect(shift.getBeds()[targetIdx]!.alarmPriority).toBe('CRISIS');

    // Step past 60s countdown on an unrescued bed and verify ISCHEMIC_ARREST CausalEvent is logged
    for (let k = 0; k < 6; k++) {
      shift.stepSeconds(10);
    }
    const expiredBed = shift.getBeds().find((b) => b.arrested && b.countdownSec === 0)!;
    expect(expiredBed).toBeTruthy();
    expect(expiredBed.vitals.rhythm).toBe('ASYSTOLE');
    expect(expiredBed.causalTimeline.some((ev) => ev.action === 'ISCHEMIC_ARREST')).toBe(true);

    // Verify CLI simulate --seed 42 --json outputs score, stabilizedBeds, and receipt (F-22)
    const simShiftRes = runCli(['simulate', '--seed', '42', '--json']);
    expect(simShiftRes.status).toBe(0);
    const simShiftJson = JSON.parse(simShiftRes.stdout.trim()) as {
      seed: string;
      numericSeed: number;
      score: number;
      scorePct: number;
      stabilizedBeds: number;
      bedsStabilized: number;
      receipt: string;
    };
    expect(simShiftJson.seed).toBe('42');
    expect(simShiftJson.numericSeed).toBe(42);
    expect(simShiftJson.score).toBe(simShiftJson.scorePct);
    expect(simShiftJson.stabilizedBeds).toBe(simShiftJson.bedsStabilized);
    expect(simShiftJson.receipt).toMatch(/^TW-42-\d+-[0-9A-F]{4}$/);
  });
});
