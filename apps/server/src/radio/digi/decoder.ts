import {
  AUDIO_SAMPLE_RATE,
  CW_TEXT_KEPT,
  DIGI_BATCHES_KEPT,
  DIGI_SLOT_MS,
  type AudioState,
  type CwState,
  type Decode,
  type DecodeBatch,
  type DecoderState,
  type DigiMode,
  type Mode,
  type MonitorMode,
} from '@radiobench/protocol';
import { errorText } from '../../util.ts';
import { CwDecoder } from '../cw/cw.ts';

/** Where the audio to decode comes from: the radio's Audio, or a stand-in in tests. */
export interface AudioSource {
  getState(): AudioState;
  onState(listener: (state: AudioState) => void): () => void;
  listen(listener: (samples: Uint8Array) => void): () => void;
}

/** Decodes the audio of one slot. The real one runs ft8ts in worker threads. */
export interface DecodeEngine {
  readonly depth: number;
  readonly threads: number;
  /** Samples are mono at AUDIO_SAMPLE_RATE; slotStart is ms since the epoch. */
  decode(mode: DigiMode, samples: Float32Array, slotStart: number): Promise<Decode[]>;
  close(): void;
}

/** What the radio was tuned to when a slot began. */
export interface Dial {
  hz: number | null;
  mode: Mode | null;
  /** The radio's CW pitch while it is in a CW mode; null otherwise. */
  cwPitchHz: number | null;
}

export interface DecoderOptions {
  /** What the radio is tuned to, asked at the start of every slot. */
  dial: () => Dial;
  mode?: MonitorMode;
  /** The clock, ms since the epoch; replaced in tests. */
  now?: () => number;
}

/** Decoded Morse as it comes, with how the decoding is going. */
export interface CwEvent {
  text: string;
  cw: CwState;
}

/** How often, at most, the Morse decoder's state goes out when no text does. */
const CW_STATUS_MS = 1000;

/** A slot that lacks more than this share of its audio was joined too late to decode. */
const MIN_SLOT_SHARE = 0.9;

type StateListener = (state: DecoderState) => void;
type BatchListener = (batch: DecodeBatch) => void;
type CwListener = (event: CwEvent) => void;

/**
 * Decodes FT8 or FT4 from the radio's received audio, one slot at a time. Slots are cut by
 * the PC's clock, as WSJT-X cuts them: every 15 s (FT8) or 7.5 s (FT4) from the top of the
 * minute, UTC. Audio is captured only while someone uses the decoder.
 */
export class Decoder {
  private readonly source: AudioSource;
  private readonly engine: DecodeEngine;
  private readonly dial: () => Dial;
  private readonly now: () => number;
  private state: DecoderState;
  private readonly stateListeners = new Set<StateListener>();
  private readonly batchListeners = new Set<BatchListener>();
  private readonly cwListeners = new Set<CwListener>();
  private readonly batches: DecodeBatch[] = [];
  // Morse: the decoder, the text it has produced lately, and the state last sent out.
  private cw = new CwDecoder();
  private cwText = '';
  private cwSent: CwState = { wpm: null, pitchHz: null, signal: false };
  private cwSentAt = 0;
  private users = 0;
  private stopListening: (() => void) | null = null;
  private unwatchAudio: (() => void) | null = null;

  // The slot being filled: its number (start / slot length), its audio so far, and the dial.
  private slot = -1;
  private buffer = new Float32Array(0);
  private filled = 0;
  private slotDial: Dial = { hz: null, mode: null, cwPitchHz: null };

  constructor(source: AudioSource, engine: DecodeEngine, options: DecoderOptions) {
    this.source = source;
    this.engine = engine;
    this.dial = options.dial;
    this.now = options.now ?? Date.now;
    this.state = {
      status: source.getState().status === 'off' ? 'off' : 'idle',
      detail: null,
      mode: options.mode ?? 'FT8',
      depth: engine.depth,
      threads: engine.threads,
    };
  }

  getState(): DecoderState {
    return this.state;
  }

  /** The decodes of the last few slots, oldest first. */
  recent(): DecodeBatch[] {
    return [...this.batches];
  }

  /** The Morse decoded lately, and how the decoding is going. */
  recentCw(): CwEvent {
    return { text: this.cwText, cw: this.cw.status() };
  }

  /** Calls the listener with Morse as it is decoded; returns a function that unsubscribes it. */
  onCw(listener: CwListener): () => void {
    this.cwListeners.add(listener);
    return () => this.cwListeners.delete(listener);
  }

  /** Calls the listener on every state change; returns a function that unsubscribes it. */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Calls the listener with each slot's decodes; returns a function that unsubscribes it. */
  onBatch(listener: BatchListener): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }

  /** Keeps the decoder running until the returned function is called. */
  use(): () => void {
    this.users++;
    if (this.users === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users--;
      if (this.users === 0) this.pause();
    };
  }

  /** Switches mode for everyone; the slot under way is dropped, as it was cut for the old one. */
  setMode(mode: MonitorMode): void {
    if (mode === this.state.mode) return;
    this.slot = -1;
    if (mode === 'CW') this.cw = new CwDecoder(this.dial().cwPitchHz);
    this.update({ ...this.state, mode });
  }

  /** Stops for good: lets the audio go and ends the decoding threads. */
  stop(): void {
    this.users = 0;
    this.pause();
    this.engine.close();
  }

  private start(): void {
    if (this.source.getState().status === 'off') return;
    this.unwatchAudio = this.source.onState((audio) => this.reflect(audio));
    this.stopListening = this.source.listen((samples) => this.receive(samples));
    this.reflect(this.source.getState());
  }

  private pause(): void {
    this.stopListening?.();
    this.unwatchAudio?.();
    this.stopListening = null;
    this.unwatchAudio = null;
    this.slot = -1;
    if (this.state.status !== 'off') this.update({ ...this.state, status: 'idle', detail: null });
  }

  /** The decoder is only as available as the audio it decodes. */
  private reflect(audio: AudioState): void {
    if (this.users === 0) return;
    if (audio.status === 'unavailable') {
      this.update({ ...this.state, status: 'unavailable', detail: audio.detail });
    } else if (audio.status === 'ready') {
      this.update({ ...this.state, status: 'running', detail: null });
    }
  }

  /** Files received audio under the slot the clock says it belongs to, or decodes it as Morse. */
  private receive(samples: Uint8Array): void {
    const mode = this.state.mode;
    if (mode === 'CW') {
      this.receiveCw(samples);
      return;
    }
    const slotMs = DIGI_SLOT_MS[mode];
    const slot = Math.floor(this.now() / slotMs);
    if (slot !== this.slot) {
      this.finishSlot();
      this.slot = slot;
      this.filled = 0;
      this.slotDial = this.dial();
      const capacity = (slotMs / 1000) * AUDIO_SAMPLE_RATE;
      if (this.buffer.length !== capacity) this.buffer = new Float32Array(capacity);
    }
    const count = Math.min(samples.length >> 1, this.buffer.length - this.filled);
    const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
    for (let i = 0; i < count; i++) {
      this.buffer[this.filled + i] = view.getInt16(i * 2, true) / 32768;
    }
    this.filled += count;
  }

  /**
   * Morse is decoded as it comes. Text goes out as soon as there is some; the state of the
   * decoding goes out with it, or by itself when it changes, at most once a second.
   */
  private receiveCw(samples: Uint8Array): void {
    // The decoder sits on the radio's own CW pitch while the radio is in a CW mode.
    this.cw.setPitch(this.dial().cwPitchHz);
    const text = this.cw.feed(samples);
    const cw = this.cw.status();
    const now = this.now();
    const changed =
      cw.wpm !== this.cwSent.wpm ||
      cw.pitchHz !== this.cwSent.pitchHz ||
      cw.signal !== this.cwSent.signal;
    if (text === '' && !(changed && now - this.cwSentAt >= CW_STATUS_MS)) return;
    this.cwText = (this.cwText + text).slice(-CW_TEXT_KEPT);
    this.cwSent = cw;
    this.cwSentAt = now;
    for (const listener of this.cwListeners) listener({ text, cw });
  }

  /** Hands the slot just ended to the engine; its decodes arrive a second or two later. */
  private finishSlot(): void {
    if (this.slot < 0 || this.filled < this.buffer.length * MIN_SLOT_SHARE) return;
    const mode = this.state.mode;
    if (mode === 'CW') return;
    const slotStart = this.slot * DIGI_SLOT_MS[mode];
    const dial = this.slotDial;
    this.engine.decode(mode, this.buffer.slice(0, this.filled), slotStart).then(
      (decodes) =>
        this.publish({ mode, slotStart, dialHz: dial.hz, radioMode: dial.mode, decodes }),
      (error: unknown) => this.update({ ...this.state, detail: errorText(error) }),
    );
  }

  private publish(batch: DecodeBatch): void {
    // A batch can arrive after the mode was switched; it still belongs to its own mode.
    this.batches.push(batch);
    this.batches.splice(0, Math.max(0, this.batches.length - DIGI_BATCHES_KEPT));
    for (const listener of this.batchListeners) listener(batch);
  }

  private update(next: DecoderState): void {
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}
