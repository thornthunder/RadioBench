import {
  AUDIO_SAMPLE_RATE,
  DIGI_SLOT_MS,
  type AudioState,
  type DigiMode,
} from '@radiobench/protocol';
import { errorText } from '../../util.ts';

/**
 * Where audio comes from and goes to: the radio's USB sound device, or the simulator.
 * Samples are 16-bit little-endian mono at AUDIO_SAMPLE_RATE in both directions.
 */
export interface AudioDevice {
  /** Starts capturing; rejects with a message fit for display when that cannot be done. */
  openInput(): Promise<void>;
  /** The samples captured since the last call. */
  read(): Uint8Array;
  closeInput(): void;
  /** Starts playing into the radio; rejects with a message fit for display when it cannot. */
  openOutput(): Promise<void>;
  write(samples: Uint8Array): void;
  closeOutput(): void;
}

const POLL_MS = 20;
/** The output device is let go this long after the last microphone audio arrived. */
const OUTPUT_IDLE_MS = 3000;

type SampleListener = (samples: Uint8Array) => void;
type StateListener = (state: AudioState) => void;

/**
 * The radio's audio, both ways. Received audio is captured only while someone listens to it;
 * microphone audio from a client is played into the radio's USB audio input, which the radio
 * transmits when it is keyed with its modulation source set to USB.
 */
export class Audio {
  private readonly device: AudioDevice | null;
  private readonly listeners = new Set<SampleListener>();
  private readonly stateListeners = new Set<StateListener>();
  private state: AudioState;
  private pollTimer: NodeJS.Timeout | null = null;
  private opening = false;
  private output: 'closed' | 'opening' | 'open' = 'closed';
  private outputTimer: NodeJS.Timeout | null = null;

  /** Without a device audio is off. canTalk says whether microphone audio is passed on. */
  constructor(device: AudioDevice | null, canTalk = false) {
    this.device = device;
    this.state = {
      status: device ? 'ready' : 'off',
      detail: null,
      canTalk: !!device && canTalk,
      talking: false,
    };
  }

  getState(): AudioState {
    return this.state;
  }

  /** Calls the listener on every state change; returns a function that unsubscribes it. */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Passes received audio to the listener until the returned function is called. */
  listen(listener: SampleListener): () => void {
    this.listeners.add(listener);
    void this.startCapture();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopCapture();
    };
  }

  /** Plays microphone audio from a client into the radio. */
  talk(samples: Uint8Array): void {
    const device = this.device;
    if (!device || !this.state.canTalk) return;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = setTimeout(() => this.closeOutput(), OUTPUT_IDLE_MS);
    if (this.output === 'open') {
      device.write(samples);
    } else if (this.output === 'closed') {
      this.output = 'opening';
      device.openOutput().then(
        () => {
          this.output = 'open';
          this.update({ ...this.state, talking: true });
        },
        (error: unknown) => {
          this.output = 'closed';
          this.update({ ...this.state, detail: errorText(error) });
        },
      );
    }
  }

  stop(): void {
    this.listeners.clear();
    this.stopCapture();
    this.closeOutput();
  }

  private async startCapture(): Promise<void> {
    const device = this.device;
    if (!device || this.pollTimer || this.opening) return;
    this.opening = true;
    try {
      await device.openInput();
    } catch (error) {
      this.update({ ...this.state, status: 'unavailable', detail: errorText(error) });
      return;
    } finally {
      this.opening = false;
    }
    if (this.listeners.size === 0) {
      device.closeInput();
      return;
    }
    this.update({ ...this.state, status: 'ready', detail: null });
    this.pollTimer = setInterval(() => {
      const samples = device.read();
      if (samples.length > 0) for (const listener of this.listeners) listener(samples);
    }, POLL_MS);
  }

  private stopCapture(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.device?.closeInput();
  }

  private closeOutput(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = null;
    if (this.output === 'open') this.device?.closeOutput();
    this.output = 'closed';
    this.update({ ...this.state, talking: false });
  }

  private update(next: AudioState): void {
    if (
      next.status === this.state.status &&
      next.detail === this.state.detail &&
      next.talking === this.state.talking
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}

/**
 * What the simulated radio hears: a few FT8 and FT4 stations of different strengths, each in
 * its slot, over band noise. The callsigns are the ones the FT8 protocol papers use.
 */
const SIMULATED_SIGNALS: {
  mode: DigiMode;
  text: string;
  hz: number;
  amplitude: number;
  dt: number;
}[] = [
  { mode: 'FT8', text: 'CQ K1ABC FN42', hz: 1200, amplitude: 3000, dt: 0 },
  { mode: 'FT8', text: 'K1ABC W9XYZ EN37', hz: 1850, amplitude: 400, dt: 0.3 },
  { mode: 'FT8', text: 'W9XYZ K1ABC -11', hz: 740, amplitude: 100, dt: -0.2 },
  { mode: 'FT4', text: 'CQ W9XYZ EN37', hz: 2300, amplitude: 1500, dt: 0 },
  { mode: 'FT4', text: 'W9XYZ K1ABC R-09', hz: 2600, amplitude: 250, dt: 0.1 },
];
/** Symbol rates of the modes: 6.25 baud and 12000/576 baud. */
const SYMBOL_RATE: Record<DigiMode, number> = { FT8: 6.25, FT4: 12000 / 576 };
/** Transmissions start this long after their slot, as in WSJT-X. */
const SLOT_LEAD_S = 0.5;
const NOISE_AMPLITUDE = 300;

interface SimulatedSignal {
  wave: Float32Array;
  slotMs: number;
  amplitude: number;
  /** When the signal starts within its slot, in seconds. */
  startS: number;
}

/** A stand-in sound device: FT8 and FT4 signals over noise come in, and what goes out is dropped. */
export class SimulatedAudioDevice implements AudioDevice {
  private readFrom = 0;
  private signals: SimulatedSignal[] = [];
  /** How many samples have been written to the radio; for tests. */
  written = 0;

  async openInput(): Promise<void> {
    if (this.signals.length === 0) {
      const { encodeFT4, encodeFT8 } = await import('@e04/ft8ts');
      this.signals = SIMULATED_SIGNALS.map((signal) => ({
        wave: (signal.mode === 'FT8' ? encodeFT8 : encodeFT4)(signal.text, {
          sampleRate: AUDIO_SAMPLE_RATE,
          samplesPerSymbol: AUDIO_SAMPLE_RATE / SYMBOL_RATE[signal.mode],
          baseFrequency: signal.hz,
        }),
        slotMs: DIGI_SLOT_MS[signal.mode],
        amplitude: signal.amplitude,
        startS: SLOT_LEAD_S + signal.dt,
      }));
    }
    // The wall clock, because the signals keep to the UTC slots a decoder cuts; taken after
    // the encoding so that the first read does not deliver a backlog that would shift them.
    this.readFrom = Date.now();
  }

  read(): Uint8Array {
    const now = Date.now();
    const count = Math.floor(((now - this.readFrom) / 1000) * AUDIO_SAMPLE_RATE);
    const samples = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) {
      const atMs = this.readFrom + (i / AUDIO_SAMPLE_RATE) * 1000;
      let value = NOISE_AMPLITUDE * (Math.random() * 2 - 1);
      for (const signal of this.signals) {
        const index = Math.floor(
          ((atMs % signal.slotMs) / 1000 - signal.startS) * AUDIO_SAMPLE_RATE,
        );
        if (index >= 0 && index < signal.wave.length) {
          value += signal.amplitude * (signal.wave[index] ?? 0);
        }
      }
      samples.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
    }
    this.readFrom += (count / AUDIO_SAMPLE_RATE) * 1000;
    return samples;
  }

  closeInput(): void {}

  async openOutput(): Promise<void> {}

  write(samples: Uint8Array): void {
    this.written += samples.length / 2;
  }

  closeOutput(): void {}
}
