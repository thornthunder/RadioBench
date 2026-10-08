/**
 * Wire protocol between the RadioBench server and its web clients.
 *
 * Everything travels over the WebSocket at WS_PATH: state and commands as JSON
 * text frames; scope sweeps and audio as binary frames. Both sides import this
 * package, so it must stay free of Node and DOM APIs.
 */
import {
  ACTIONS,
  MODES,
  isSettingKey,
  isValidSetting,
  type Action,
  type Mode,
  type SettingKey,
  type Settings,
} from './controls.ts';
import { encodeMenuValue, findMenuItem } from './menu.ts';

export * from './controls.ts';
export * from './menu.ts';

export const WS_PATH = '/ws';
// Below 1024 on purpose: Windows can be set to hand out any port from 1024 up for outgoing
// connections, and a port in that range is then taken by some other program now and again.
export const DEFAULT_HTTP_PORT = 81;

export type LinkStatus = 'disconnected' | 'connecting' | 'connected';

/** Whether the radio is on a VFO or on one of its kinds of memory. */
export type VfoState = 'vfo' | 'memory' | 'memory-tune' | 'qmb' | 'pms';

/** Everything the server knows about the radio. Readings are null until they have been read. */
export interface RadioState extends Settings {
  /** State of the CAT link between the server and the radio. */
  link: LinkStatus;
  /** Why the link is down, worded for display; null otherwise. */
  linkError: string | null;
  /** Serial port carrying CAT (e.g. "COM3"), or "sim" for the built-in simulator. */
  port: string | null;
  /** Whether the server lets clients key the transmitter; see RADIOBENCH_TX. */
  txEnabled: boolean;

  transmitting: boolean;
  /** The antenna system looks wrong to the radio; it shows HI-SWR. */
  hiSwr: boolean;
  /** The squelch is open. */
  busy: boolean;
  /** An antenna tuning cycle is running. */
  tuning: boolean;
  scanning: boolean;
  /** The radio's recorder is recording the received audio to its SD card. */
  recording: boolean;
  /** The radio is playing back a voice memory. */
  playing: boolean;
  vfoState: VfoState | null;
  /** The recalled memory channel, e.g. "001"; "000" on a VFO. */
  memoryChannel: string | null;

  /** Meter readings as the radio reports them: 0–255, uncalibrated. */
  sMeter: number | null;
  meterPo: number | null;
  meterSwr: number | null;
  meterAlc: number | null;
  meterComp: number | null;
  meterId: number | null;
  meterVdd: number | null;

  /** Menu settings that shape how the knobs behave. */
  dialStepSsbCwHz: number | null;
  dialStepDataHz: number | null;
  channelStepHz: number | null;
  /** What the [RF GAIN/SQL] knob is set to control. */
  rfSqlKnob: 'RF' | 'SQL' | null;

  /** Version of the radio's main firmware, e.g. "01-12". */
  firmware: string | null;
}

export type ScopeStatus = 'off' | 'unavailable' | 'running';

export interface ScopeState {
  /** "off": disabled in the server's settings. "unavailable": wanted, but no sweeps are arriving. */
  status: ScopeStatus;
  /** Why the scope is unavailable, worded for display; null otherwise. */
  detail: string | null;
}

export interface AudioState {
  /** "off": disabled in the server's settings. "unavailable": the radio's sound device cannot be used. */
  status: 'off' | 'unavailable' | 'ready';
  /** Why audio is unavailable, worded for display; null otherwise. */
  detail: string | null;
  /** Whether microphone audio sent by a client is passed on to the radio. */
  canTalk: boolean;
  /** Whether microphone audio is arriving from a client and being played into the radio. */
  talking: boolean;
}

/** One of the radio's memory channels. */
export interface MemoryChannel {
  /** "001" to "099", or one of the special channels such as "EMG". */
  channel: string;
  frequencyHz: number;
  mode: Mode;
  /** The channel's name, up to MEMORY_TAG_LENGTH characters; empty if it has none. */
  tag: string;
}

export const MEMORY_CHANNELS = 99;
export const MEMORY_TAG_LENGTH = 12;
/** The radio's CW text memories. */
export const CW_MESSAGES = 5;
export const CW_MESSAGE_LENGTH = 50;
/** The radio's voice memories. */
export const VOICE_MEMORIES = 5;

/** Number of points in one sweep of the radio's spectrum scope. */
export const SCOPE_BINS = 850;
/** Number of points in the audio spectrum that comes with each sweep. */
export const AUDIO_SPECTRUM_BINS = 200;
/** Number of columns in the audio oscilloscope trace that comes with each sweep. */
export const AUDIO_WAVE_COLUMNS = 200;

/** One sweep of the radio's spectrum scope, with what the radio's MULTI view shows beside it. */
export interface ScopeFrame {
  /** Frequency at the left edge of the sweep. */
  startHz: number;
  spanHz: number;
  /** The S-meter at the time of the sweep: 0–255, uncalibrated. */
  sMeter: number;
  /** Signal strength per point, left to right: 0–255, uncalibrated, higher is stronger. */
  bins: Uint8Array;
  /** Spectrum of the received audio, low to high: 0–255, uncalibrated, higher is stronger. */
  audioSpectrum: Uint8Array;
  /**
   * Oscilloscope trace of the received audio: for each column the two ends of the stroke the
   * radio draws there, 0–255 with 128 or so as the centre line.
   */
  audioWave: Uint8Array;
}

/** Audio travels as 16-bit little-endian mono samples at this rate, in both directions. */
export const AUDIO_SAMPLE_RATE = 16_000;

/** The digital modes the server can decode from the received audio. */
export const DIGI_MODES = ['FT8', 'FT4'] as const;
export type DigiMode = (typeof DIGI_MODES)[number];
/** How long a transmission slot is in each mode. Slots start on multiples of this since 00:00 UTC. */
export const DIGI_SLOT_MS: Record<DigiMode, number> = { FT8: 15_000, FT4: 7_500 };
/** How many slots' decodes the server keeps for clients that join later. */
export const DIGI_BATCHES_KEPT = 20;
/** Decoding depth as in WSJT-X: 1 fast, 2 normal, 3 deep. */
export const DIGI_DEPTHS = [1, 2, 3] as const;

export interface DecoderState {
  /**
   * "off": there is no audio to decode (audio is disabled). "idle": nobody has asked for
   * decodes. "running": decoding every slot. "unavailable": wanted, but the audio cannot be
   * captured.
   */
  status: 'off' | 'idle' | 'running' | 'unavailable';
  /** Why decoding is unavailable, worded for display; null otherwise. */
  detail: string | null;
  mode: DigiMode;
  depth: number;
  /** How many threads decode at once. */
  threads: number;
}

/** One decoded transmission. */
export interface Decode {
  /** Signal-to-noise ratio in dB, as WSJT-X reports it (2500 Hz bandwidth). */
  snr: number;
  /** How late the sender's clock is against this PC's, in seconds. */
  dt: number;
  /** Audio frequency of the signal in Hz; add the dial frequency for the RF frequency. */
  hz: number;
  text: string;
  /** Set for a priori decodes (as in WSJT-X), which are more likely to be false. */
  ap?: number;
}

/** The decodes of one slot. */
export interface DecodeBatch {
  mode: DigiMode;
  /** Start of the slot, ms since the epoch (UTC). */
  slotStart: number;
  /** The dial frequency and mode the radio was on when the slot began; null if unknown. */
  dialHz: number | null;
  radioMode: Mode | null;
  decodes: Decode[];
}

export type ServerMessage =
  // The whole state, sent when a client connects.
  | { type: 'state'; state: RadioState }
  // What has changed since.
  | { type: 'patch'; patch: Partial<RadioState> }
  | { type: 'scope'; scope: ScopeState }
  | { type: 'audio'; audio: AudioState }
  // Menu values as read from the radio: the characters of the EX reply, by menu item id.
  | { type: 'menu'; values: Record<string, string> }
  // The memory channels in use, after they were asked for or changed.
  | { type: 'memories'; channels: MemoryChannel[] }
  // The radio's CW text memories, first to last.
  | { type: 'messages'; texts: string[] }
  | { type: 'decoder'; decoder: DecoderState }
  // Decodes of one or more slots, oldest first.
  | { type: 'decodes'; batches: DecodeBatch[] }
  // A command this client sent could not be carried out.
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'set'; key: SettingKey; value: boolean | number | string }
  | { type: 'action'; action: Action; value?: number }
  // Start or stop receiving the radio's audio.
  | { type: 'listen'; on: boolean }
  // Start or stop receiving decodes; the mode, when given, is switched for everyone.
  | { type: 'decode'; on: boolean; mode?: DigiMode }
  | { type: 'menuRead'; ids: string[] }
  // The value is an option's position, a number or text, as the menu item calls for.
  | { type: 'menuSet'; id: string; value: number | string }
  | { type: 'memoryList' }
  | { type: 'memoryRecall'; channel: string }
  // Stores the main VFO's frequency and mode in a channel.
  | { type: 'memoryStore'; channel: string }
  | { type: 'memoryTag'; channel: string; tag: string }
  | { type: 'messageList' }
  | { type: 'messageStore'; number: number; text: string }
  // Sends a CW text memory on the air; 0 stops it.
  | { type: 'messagePlay'; number: number }
  // Plays a voice memory on the air; 0 stops it.
  | { type: 'voicePlay'; number: number }
  // Starts or stops the radio's recording of the received audio.
  | { type: 'record'; on: boolean }
  // Switches the radio on or off.
  | { type: 'power'; on: boolean };

// Binary frames start with a byte saying what they carry.
const SCOPE_FRAME_KIND = 1;
/** Received audio, server to client: the kind byte, an unused byte, then the samples. */
export const RX_AUDIO_KIND = 2;
/** Microphone audio, client to server, laid out the same way. */
export const TX_AUDIO_KIND = 3;
const AUDIO_HEADER_LENGTH = 2;

// A scope frame: the kind byte, the S-meter, two unused bytes, startHz as a signed and spanHz
// as an unsigned 32-bit little-endian integer, then the sweep, audio spectrum and audio trace.
const SCOPE_HEADER_LENGTH = 12;
const SCOPE_FRAME_LENGTH =
  SCOPE_HEADER_LENGTH + SCOPE_BINS + AUDIO_SPECTRUM_BINS + AUDIO_WAVE_COLUMNS * 2;

export function encodeScopeFrame(frame: ScopeFrame): Uint8Array {
  const packet = new Uint8Array(SCOPE_FRAME_LENGTH);
  const header = new DataView(packet.buffer);
  header.setUint8(0, SCOPE_FRAME_KIND);
  header.setUint8(1, frame.sMeter);
  header.setInt32(4, frame.startHz, true);
  header.setUint32(8, frame.spanHz, true);
  packet.set(frame.bins, SCOPE_HEADER_LENGTH);
  packet.set(frame.audioSpectrum, SCOPE_HEADER_LENGTH + SCOPE_BINS);
  packet.set(frame.audioWave, SCOPE_HEADER_LENGTH + SCOPE_BINS + AUDIO_SPECTRUM_BINS);
  return packet;
}

/** Decodes a binary frame received from the server; null if it is not a scope frame. */
export function decodeScopeFrame(packet: ArrayBuffer): ScopeFrame | null {
  if (packet.byteLength !== SCOPE_FRAME_LENGTH) return null;
  const header = new DataView(packet);
  if (header.getUint8(0) !== SCOPE_FRAME_KIND) return null;
  const spectrumAt = SCOPE_HEADER_LENGTH + SCOPE_BINS;
  return {
    startHz: header.getInt32(4, true),
    spanHz: header.getUint32(8, true),
    sMeter: header.getUint8(1),
    bins: new Uint8Array(packet, SCOPE_HEADER_LENGTH, SCOPE_BINS),
    audioSpectrum: new Uint8Array(packet, spectrumAt, AUDIO_SPECTRUM_BINS),
    audioWave: new Uint8Array(packet, spectrumAt + AUDIO_SPECTRUM_BINS),
  };
}

/** Wraps audio samples (16-bit little-endian mono) in a binary frame of the given kind. */
export function encodeAudio(kind: number, samples: Uint8Array): Uint8Array {
  const packet = new Uint8Array(AUDIO_HEADER_LENGTH + samples.length);
  packet[0] = kind;
  packet.set(samples, AUDIO_HEADER_LENGTH);
  return packet;
}

/** The samples of an audio frame of the given kind; null if the frame is something else. */
export function decodeAudio(kind: number, packet: ArrayBuffer | Uint8Array): Uint8Array | null {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (bytes.length < AUDIO_HEADER_LENGTH || bytes[0] !== kind) return null;
  // Whole samples only.
  const length = (bytes.length - AUDIO_HEADER_LENGTH) & ~1;
  return bytes.subarray(AUDIO_HEADER_LENGTH, AUDIO_HEADER_LENGTH + length);
}

const isChannel = (value: unknown): value is string =>
  typeof value === 'string' && /^(0[1-9]\d|0\d[1-9])$/.test(value);
const isNumberIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
// A semicolon ends a CAT command, so no text that goes into one may contain it.
const isPrintable = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length <= maxLength && /^[\x20-\x3a\x3c-\x7d]*$/.test(value);
/** What the radio's keyer can send: letters, digits and the punctuation Morse has signs for. */
const isCwText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= CW_MESSAGE_LENGTH &&
  /^[A-Z0-9 !"#$%&'()*+,\-./:<=>?@[\\\]^_]*$/.test(value);

/** Parses a frame received from a client; null if it is not a valid ClientMessage. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case 'set': {
      const { key, value } = message;
      if (!isSettingKey(key) || !isValidSetting(key, value)) return null;
      return { type: 'set', key, value: value as boolean | number | string };
    }
    case 'action': {
      const { action, value } = message;
      if (!(ACTIONS as readonly unknown[]).includes(action)) return null;
      if (value !== undefined && !Number.isInteger(value)) return null;
      return {
        type: 'action',
        action: action as Action,
        ...(value === undefined ? {} : { value: value as number }),
      };
    }
    case 'listen':
    case 'record':
    case 'power':
      return typeof message.on === 'boolean' ? { type: message.type, on: message.on } : null;
    case 'decode': {
      const { on, mode } = message;
      if (typeof on !== 'boolean') return null;
      if (mode === undefined) return { type: 'decode', on };
      return (DIGI_MODES as readonly unknown[]).includes(mode)
        ? { type: 'decode', on, mode: mode as DigiMode }
        : null;
    }
    case 'menuRead': {
      const { ids } = message;
      if (!Array.isArray(ids) || ids.length > 400) return null;
      return ids.every((id) => typeof id === 'string' && findMenuItem(id))
        ? { type: 'menuRead', ids: ids as string[] }
        : null;
    }
    case 'menuSet': {
      const { id, value } = message;
      const item = typeof id === 'string' ? findMenuItem(id) : undefined;
      if (!item || (typeof value !== 'number' && typeof value !== 'string')) return null;
      return encodeMenuValue(item, value) === null ? null : { type: 'menuSet', id: item.id, value };
    }
    case 'memoryList':
    case 'messageList':
      return { type: message.type };
    case 'memoryRecall':
    case 'memoryStore':
      return isChannel(message.channel) ? { type: message.type, channel: message.channel } : null;
    case 'memoryTag':
      return isChannel(message.channel) && isPrintable(message.tag, MEMORY_TAG_LENGTH)
        ? { type: 'memoryTag', channel: message.channel, tag: message.tag }
        : null;
    case 'messageStore':
      return isNumberIn(message.number, 1, CW_MESSAGES) && isCwText(message.text)
        ? { type: 'messageStore', number: message.number, text: message.text }
        : null;
    case 'messagePlay':
      return isNumberIn(message.number, 0, CW_MESSAGES)
        ? { type: 'messagePlay', number: message.number }
        : null;
    case 'voicePlay':
      return isNumberIn(message.number, 0, VOICE_MEMORIES)
        ? { type: 'voicePlay', number: message.number }
        : null;
    default:
      return null;
  }
}

/** Whether a value names an operating mode. */
export function isMode(value: unknown): value is Mode {
  return (MODES as readonly unknown[]).includes(value);
}
