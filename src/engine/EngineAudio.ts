import type { DrivingTelemetry, VehicleType } from '../types/streetview';

/**
 * Procedural Web Audio driving synthesizer.
 * Generates synchronized engine purr/revving (Car V6/V8 vs Bike Inline-4),
 * gear-shift exhaust pops, tire drift chirps, and high-speed wind rush —
 * using zero external audio files and auto-unlocking on first user gesture.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  // Engine voice
  private oscPrimary: OscillatorNode | null = null;
  private oscSub: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  // Tire screech & wind voices
  private tireFilter: BiquadFilterNode | null = null;
  private tireGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private vehicleType: VehicleType = 'car';
  private muted = false;
  private initialized = false;
  private disposed = false;

  public unlock(): void {
    if (this.disposed) return;

    if (!this.initialized) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      try {
        const ctx = new AudioCtx();
        this.ctx = ctx;

        const master = ctx.createGain();
        master.gain.value = this.muted ? 0 : 0.24;
        master.connect(ctx.destination);
        this.masterGain = master;

        // 1. Engine dual-oscillator synth -> resonant lowpass filter -> gain
        const engineFilter = ctx.createBiquadFilter();
        engineFilter.type = 'lowpass';
        engineFilter.frequency.value = 280;
        engineFilter.Q.value = 3.2;

        const engineGain = ctx.createGain();
        engineGain.gain.value = 0.08;
        engineFilter.connect(engineGain);
        engineGain.connect(master);

        const oscPrimary = ctx.createOscillator();
        oscPrimary.type = 'sawtooth';
        oscPrimary.frequency.value = 56;

        const oscSub = ctx.createOscillator();
        oscSub.type = 'triangle';
        oscSub.frequency.value = 28;

        const subGain = ctx.createGain();
        subGain.gain.value = 0.65;
        oscSub.connect(subGain);
        subGain.connect(engineFilter);
        oscPrimary.connect(engineFilter);

        oscPrimary.start();
        oscSub.start();

        this.oscPrimary = oscPrimary;
        this.oscSub = oscSub;
        this.engineFilter = engineFilter;
        this.engineGain = engineGain;

        // Shared 2-second white noise buffer for tire screech & wind rush
        const sampleRate = ctx.sampleRate;
        const noiseBuffer = ctx.createBuffer(1, sampleRate * 2, sampleRate);
        const channel = noiseBuffer.getChannelData(0);
        for (let i = 0; i < channel.length; i += 1) {
          channel[i] = Math.random() * 2 - 1;
        }

        // 2. Tire chirp / drift screech (narrow bandpass noise)
        const tireSource = ctx.createBufferSource();
        tireSource.buffer = noiseBuffer;
        tireSource.loop = true;

        const tireFilter = ctx.createBiquadFilter();
        tireFilter.type = 'bandpass';
        tireFilter.frequency.value = 1380;
        tireFilter.Q.value = 6.5;

        const tireGain = ctx.createGain();
        tireGain.gain.value = 0;

        tireSource.connect(tireFilter);
        tireFilter.connect(tireGain);
        tireGain.connect(master);
        tireSource.start();

        this.tireFilter = tireFilter;
        this.tireGain = tireGain;

        // 3. High-speed aerodynamic wind rush
        const windSource = ctx.createBufferSource();
        windSource.buffer = noiseBuffer;
        windSource.loop = true;

        const windFilter = ctx.createBiquadFilter();
        windFilter.type = 'lowpass';
        windFilter.frequency.value = 460;
        windFilter.Q.value = 0.7;

        const windGain = ctx.createGain();
        windGain.gain.value = 0;

        windSource.connect(windFilter);
        windFilter.connect(windGain);
        windGain.connect(master);
        windSource.start();

        this.windFilter = windFilter;
        this.windGain = windGain;
        this.initialized = true;
      } catch {
        // AudioContext unavailable in restricted environments
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
  }

  public setVehicleType(type: VehicleType): void {
    this.vehicleType = type;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.24, this.ctx.currentTime, 0.04);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  private triggerShiftPop(): void {
    if (!this.ctx || !this.masterGain || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const popOsc = this.ctx.createOscillator();
    const popGain = this.ctx.createGain();

    popOsc.type = 'triangle';
    popOsc.frequency.setValueAtTime(this.vehicleType === 'bike' ? 145 : 102, now);
    popOsc.frequency.exponentialRampToValueAtTime(38, now + 0.085);

    popGain.gain.setValueAtTime(0.32, now);
    popGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    popOsc.connect(popGain);
    popGain.connect(this.masterGain);
    popOsc.start(now);
    popOsc.stop(now + 0.095);
  }

  public update(telemetry: DrivingTelemetry): void {
    if (!this.initialized || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const isBike = this.vehicleType === 'bike';
    const rpm = Math.max(0.12, Math.min(1, telemetry.rpm));

    // Engine fundamental & harmonic pitch
    const baseFreq = isBike ? 76 + rpm * 290 : 48 + rpm * 155;
    const subRatio = isBike ? 0.5 : 0.502;
    const filterFreq = isBike ? 340 + rpm * 2200 : 210 + rpm * 1350;
    const throttleBoost = telemetry.isAccelerating ? 1.45 : 0.92;
    const targetEngineVol = Math.min(0.42, (0.09 + rpm * 0.2) * throttleBoost);

    this.oscPrimary?.frequency.setTargetAtTime(baseFreq, now, 0.035);
    this.oscSub?.frequency.setTargetAtTime(baseFreq * subRatio, now, 0.035);
    this.engineFilter?.frequency.setTargetAtTime(filterFreq, now, 0.04);
    this.engineGain?.gain.setTargetAtTime(targetEngineVol, now, 0.05);

    if (telemetry.justShiftedGear) {
      this.triggerShiftPop();
    }

    // Tire chirp / drift screech
    const drift = Math.max(0, Math.min(1, telemetry.driftIntensity));
    const tireVol = drift > 0.12 ? (drift - 0.12) * 0.28 : 0;
    this.tireFilter?.frequency.setTargetAtTime(1180 + drift * 520, now, 0.03);
    this.tireGain?.gain.setTargetAtTime(tireVol, now, 0.04);

    // Aerodynamic wind rush above 35 km/h
    const windFactor = Math.max(0, Math.min(1, (telemetry.speedKmh - 32) / 88));
    this.windFilter?.frequency.setTargetAtTime(320 + windFactor * 880, now, 0.08);
    this.windGain?.gain.setTargetAtTime(windFactor * 0.18, now, 0.08);
  }

  public dispose(): void {
    this.disposed = true;
    try {
      this.oscPrimary?.stop();
      this.oscSub?.stop();
      if (this.ctx && this.ctx.state !== 'closed') {
        void this.ctx.close();
      }
    } catch {
      // Ignore cleanup errors
    }
    this.ctx = null;
    this.initialized = false;
  }
}
