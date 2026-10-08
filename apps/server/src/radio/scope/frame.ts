import {
  AUDIO_SPECTRUM_BINS,
  AUDIO_WAVE_COLUMNS,
  SCOPE_BINS,
  type ScopeFrame,
} from '@radiobench/protocol';

export const FRAME_LENGTH = 4096;
/** Every frame ends with the marker ff 01 ee 01, four times over. */
export const FRAME_TAIL = Buffer.from('ff01ee01'.repeat(4), 'hex');

// Layout of a frame, as worked out by the wfview project and confirmed on an FT-710:
//      0  850 bytes  sweep of the main receiver, inverted (0 is the strongest signal)
//    850  850 bytes  second receiver's sweep; all zero on the FT-710
//   1700  200 bytes  spectrum of the received audio, inverted like the sweep
//   1900  400 bytes  oscilloscope trace of the audio: 200 columns, the two ends of each stroke
//   2300  600 bytes  the same two for a second receiver; all zero on the FT-710
//   2900  150 bytes  radio status
//   3050 1030 bytes  zeros
//   4080   16 bytes  FRAME_TAIL
const AUDIO_SPECTRUM_OFFSET = 1700;
const AUDIO_WAVE_OFFSET = 1900;
const STATUS_OFFSET = 2900;
// Positions within the status block.
const SCOPE_MODE = 17;
const SPAN = 32;
const VFO_A_BCD = 64; // five bytes: ten decimal digits, Hz
const S_METER = 110;
const FIXED_START = 144; // four bytes big-endian, Hz

/** Sweep widths the radio offers, indexed by the span byte. */
const SPANS_HZ = [
  1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
];

// Scope modes in which the sweep is centred on VFO-A. In the others (cursor and fixed) it
// starts at a set frequency instead. Only mode 4 has been seen on a real radio so far; the
// grouping and the start-frequency field of the other modes follow wfview's notes.
const CENTRE_MODES = new Set([0x0, 0x3, 0x4, 0x5]);

function bcd(bytes: Uint8Array): number | null {
  let value = 0;
  for (const byte of bytes) {
    const tens = byte >> 4;
    const ones = byte & 0x0f;
    if (tens > 9 || ones > 9) return null;
    value = value * 100 + tens * 10 + ones;
  }
  return value;
}

/** Position of the frame tail within the bytes, or -1. */
export function indexOfTail(bytes: Uint8Array): number {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(FRAME_TAIL);
}

/** Decodes one frame of the scope stream; null if the bytes are not an intact frame. */
export function parseScopeFrame(frame: Uint8Array): ScopeFrame | null {
  if (frame.length !== FRAME_LENGTH) return null;
  if (indexOfTail(frame.subarray(FRAME_LENGTH - FRAME_TAIL.length)) !== 0) return null;

  const status = frame.subarray(STATUS_OFFSET);
  const spanHz = SPANS_HZ[status[SPAN] ?? -1];
  const vfoAHz = bcd(status.subarray(VFO_A_BCD, VFO_A_BCD + 5));
  if (spanHz === undefined || vfoAHz === null) return null;

  const startHz = CENTRE_MODES.has(status[SCOPE_MODE] ?? -1)
    ? vfoAHz - spanHz / 2
    : new DataView(status.buffer, status.byteOffset).getUint32(FIXED_START);

  const bins = new Uint8Array(SCOPE_BINS);
  for (let i = 0; i < SCOPE_BINS; i++) bins[i] = 255 - (frame[i] ?? 0);
  // The audio spectrum is inverted like the sweep; the oscilloscope trace is passed on as it is.
  const audioSpectrum = new Uint8Array(AUDIO_SPECTRUM_BINS);
  for (let i = 0; i < AUDIO_SPECTRUM_BINS; i++) {
    audioSpectrum[i] = 255 - (frame[AUDIO_SPECTRUM_OFFSET + i] ?? 0);
  }
  const audioWave = frame.slice(AUDIO_WAVE_OFFSET, AUDIO_WAVE_OFFSET + AUDIO_WAVE_COLUMNS * 2);
  return { startHz, spanHz, sMeter: status[S_METER] ?? 0, bins, audioSpectrum, audioWave };
}
