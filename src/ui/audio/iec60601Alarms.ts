import type { AlarmPriority } from '../../types/teleward.ts';

export interface IecBurstDescriptor {
  priority: AlarmPriority;
  pulseCount: number;
  notes: readonly string[];
  frequenciesHz: readonly number[];
}

const HIGH_PRIORITY_NOTES = ['C4', 'E4', 'G4', 'B4', 'C5'] as const;
const HIGH_PRIORITY_FREQS = [261.63, 329.63, 392.0, 493.88, 523.25] as const;

const MEDIUM_PRIORITY_NOTES = ['C4', 'E4', 'G4'] as const;
const MEDIUM_PRIORITY_FREQS = [261.63, 329.63, 392.0] as const;

/**
 * Pure WebAudio API IEC 60601-1-8 medical alarm synthesizer (0 external audio files).
 * Arbitrates High Priority (10-pulse C4-E4-G4-B4-C5) > Medium Priority (3-pulse C4-E4-G4) > QRS SpO2 beep.
 */
export class Iec60601AlarmSynthesizer {
  private activePriority: AlarmPriority = 'NORMAL';
  private armed = false;
  private muted = false;
  private audioCtx: AudioContext | null = null;
  private lastBurstTimeMs = 0;

  public isArmed(): boolean {
    return this.armed;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
  }

  public getActivePriority(): AlarmPriority {
    return this.activePriority;
  }

  public arbitratePriority(bedPriorities: readonly AlarmPriority[]): AlarmPriority {
    let highest: AlarmPriority = 'NORMAL';
    for (const p of bedPriorities) {
      if (p === 'CRISIS') {
        highest = 'CRISIS';
        break;
      }
      if (p === 'WARNING') {
        highest = 'WARNING';
      }
    }
    this.activePriority = highest;
    return highest;
  }

  public getBurstDescriptor(): IecBurstDescriptor {
    if (this.activePriority === 'CRISIS') {
      return {
        priority: 'CRISIS',
        pulseCount: 10,
        notes: HIGH_PRIORITY_NOTES,
        frequenciesHz: HIGH_PRIORITY_FREQS,
      };
    }
    if (this.activePriority === 'WARNING') {
      return {
        priority: 'WARNING',
        pulseCount: 3,
        notes: MEDIUM_PRIORITY_NOTES,
        frequenciesHz: MEDIUM_PRIORITY_FREQS,
      };
    }
    return {
      priority: 'NORMAL',
      pulseCount: 1,
      notes: ['A4'],
      frequenciesHz: [440.0],
    };
  }

  public armAudio(): boolean {
    try {
      const AudioContextCtor =
        typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;
      if (!AudioContextCtor) {
        this.armed = false;
        return false;
      }
      if (!this.audioCtx) {
        this.audioCtx = new AudioContextCtor();
      }
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }
      this.armed = true;
      return true;
    } catch {
      this.armed = false;
      return false;
    }
  }

  public triggerBurstIfDue(spo2Pct = 98, nowMs = Date.now()): void {
    if (!this.armed || this.muted || !this.audioCtx) {
      return;
    }
    const cooldownMs =
      this.activePriority === 'CRISIS'
        ? 2400
        : this.activePriority === 'WARNING'
          ? 3800
          : 1200;

    if (nowMs - this.lastBurstTimeMs < cooldownMs) {
      return;
    }
    this.lastBurstTimeMs = nowMs;

    try {
      const ctx = this.audioCtx;
      const now = ctx.currentTime;
      const desc = this.getBurstDescriptor();

      if (desc.priority === 'NORMAL') {
        // SpO2 pitch-modulated QRS pulse tone (320 Hz at 70% SpO2 -> 660 Hz at 100% SpO2)
        const pitchHz = 320 + Math.max(0, Math.min(100, spo2Pct) - 70) * 11.3;
        this.scheduleHarmonicNote(ctx, pitchHz, now, 0.06, 0.04);
        return;
      }

      const stepSec = desc.priority === 'CRISIS' ? 0.14 : 0.22;
      for (let i = 0; i < desc.pulseCount; i++) {
        const freq = desc.frequenciesHz[i % desc.frequenciesHz.length]!;
        const pauseOffset = desc.priority === 'CRISIS' && i >= 5 ? 0.18 : 0;
        this.scheduleHarmonicNote(ctx, freq, now + i * stepSec + pauseOffset, 0.09, 0.065);
      }
    } catch {
      this.armed = false;
    }
  }

  private scheduleHarmonicNote(
    ctx: AudioContext,
    freqHz: number,
    startTime: number,
    durationSec: number,
    gainPeak: number
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freqHz, startTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // Ignore already-disconnected nodes
      }
    };
    osc.start(startTime);
    osc.stop(startTime + durationSec + 0.01);
  }

  public close(): void {
    this.armed = false;
    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch {
        // Ignore already-closed AudioContext
      }
      this.audioCtx = null;
    }
  }
}
