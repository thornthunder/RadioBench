import { readFileSync } from 'node:fs';
import { AUDIO_SAMPLE_RATE } from '@radiobench/protocol';
import { describe, expect, test } from 'vitest';
import { CwDecoder } from './cw.ts';
import { ditMs, keying } from './morse.ts';

interface SignalOptions {
  wpm: number;
  pitchHz?: number;
  /** Tone amplitude, of the 16-bit full scale. */
  amplitude?: number;
  /** Noise amplitude, of the 16-bit full scale. */
  noise?: number;
  /** Silence before and after, in seconds. */
  lead?: number;
  tail?: number;
}

/** The audio of a text sent in Morse: a keyed tone with soft edges, over noise. */
function cwAudio(text: string, options: SignalOptions): Uint8Array {
  const { wpm, pitchHz = 700, amplitude = 0.3, noise = 0.01, lead = 0.3, tail = 1.2 } = options;
  const dit = ditMs(wpm) / 1000;
  const elements = keying(text);
  const seconds = lead + elements.reduce((sum, e) => sum + e.dits * dit, 0) + tail;
  const count = Math.ceil(seconds * AUDIO_SAMPLE_RATE);
  const samples = new Int16Array(count);
  // Noise first, then the keyed tone laid over it.
  for (let i = 0; i < count; i++) samples[i] = Math.round(32767 * noise * (Math.random() * 2 - 1));
  const edge = Math.round(0.005 * AUDIO_SAMPLE_RATE);
  let at = Math.round(lead * AUDIO_SAMPLE_RATE);
  for (const element of elements) {
    const length = Math.round(element.dits * dit * AUDIO_SAMPLE_RATE);
    if (element.on) {
      for (let i = 0; i < length; i++) {
        const envelope =
          i < edge
            ? 0.5 - 0.5 * Math.cos((Math.PI * i) / edge)
            : i >= length - edge
              ? 0.5 - 0.5 * Math.cos((Math.PI * (length - i)) / edge)
              : 1;
        const tone = Math.sin((2 * Math.PI * pitchHz * (at + i)) / AUDIO_SAMPLE_RATE);
        samples[at + i] = Math.max(
          -32768,
          Math.min(32767, (samples[at + i] ?? 0) + Math.round(32767 * amplitude * envelope * tone)),
        );
      }
    }
    at += length;
  }
  return new Uint8Array(samples.buffer);
}

/** Feeds audio to a decoder in 20 ms chunks, as the server does, and returns the text. */
function decode(decoder: CwDecoder, audio: Uint8Array): string {
  const chunk = (AUDIO_SAMPLE_RATE / 50) * 2;
  let text = '';
  for (let at = 0; at < audio.length; at += chunk) {
    text += decoder.feed(audio.subarray(at, Math.min(audio.length, at + chunk)));
  }
  return text;
}

describe('keying', () => {
  test('follows the standard timing', () => {
    expect(keying('et')).toEqual([
      { on: true, dits: 1 },
      { on: false, dits: 3 },
      { on: true, dits: 3 },
    ]);
    expect(keying('e e')).toEqual([
      { on: true, dits: 1 },
      { on: false, dits: 7 },
      { on: true, dits: 1 },
    ]);
    expect(
      keying('<SK>')
        .filter((e) => e.on)
        .map((e) => e.dits),
    ).toEqual([1, 1, 1, 3, 1, 3]);
    expect(ditMs(20)).toBe(60);
  });
});

describe('CwDecoder', () => {
  const message = 'CQ CQ DE K1ABC K1ABC K';

  test.each([12, 20, 28, 36])('reads clean keying at %i words per minute', (wpm) => {
    const decoder = new CwDecoder(700);
    const text = decode(decoder, cwAudio(message, { wpm }));
    expect(text.trim()).toBe(message);
    expect(decoder.status().pitchHz).toBe(700);
  });

  test('reads keying in noise, and reports the speed', () => {
    const decoder = new CwDecoder(700);
    const options = { wpm: 22, amplitude: 0.1, noise: 0.02 };
    let text = decode(decoder, cwAudio(message, { ...options, tail: 0.1 }));
    expect(decoder.status().signal).toBe(true);
    expect(decoder.status().wpm).toBeGreaterThanOrEqual(20);
    expect(decoder.status().wpm).toBeLessThanOrEqual(24);
    // The silence after lets the last character out, and the signal go.
    text += decode(decoder, cwAudio('', { ...options, tail: 1.5 }));
    expect(text.trim()).toBe(message);
    expect(decoder.status()).toMatchObject({ signal: false, wpm: null });
  });

  test('finds the tone by itself when the radio does not say', () => {
    const decoder = new CwDecoder(null);
    expect(decoder.status()).toEqual({ wpm: null, pitchHz: null, signal: false });
    const text = decode(decoder, cwAudio('VVV DE K1ABC ' + message, { wpm: 20, pitchHz: 550 }));
    // The tone found stays on show after the signal has gone.
    expect(decoder.status()).toEqual({ wpm: null, pitchHz: 550, signal: false });
    // The first word or so goes by while the tone is being found.
    expect(text).toContain(message);
  });

  test('follows a change of speed', () => {
    const decoder = new CwDecoder(700);
    const slow = decode(decoder, cwAudio('CQ CQ DE K1ABC', { wpm: 15 }));
    const faster = decode(decoder, cwAudio('K1ABC K', { wpm: 22, lead: 0.5 }));
    expect(slow.trim()).toBe('CQ CQ DE K1ABC');
    expect(faster.trim()).toBe('K1ABC K');
    // A sudden doubling of speed costs the first word or two, then the decoder has caught up.
    const doubled = decode(decoder, cwAudio('VVV VVV VVV DE K1ABC K', { wpm: 40, lead: 0.5 }));
    expect(doubled.trim().endsWith('K1ABC K')).toBe(true);
  });

  test('says nothing about noise alone, and lets a lost signal go', () => {
    const decoder = new CwDecoder(700);
    const silence = decode(decoder, cwAudio('', { wpm: 20, noise: 0.03, tail: 6 }));
    expect(silence.trim()).toBe('');
    expect(decoder.status().signal).toBe(false);
    decode(decoder, cwAudio('TEST', { wpm: 20, tail: 0.1 }));
    expect(decoder.status().signal).toBe(true);
    decode(decoder, cwAudio('', { wpm: 20, tail: 6 }));
    expect(decoder.status()).toMatchObject({ signal: false, wpm: null });
  });
});

// The decoder's constants were tuned against these: many runs with fresh noise each time.
describe('CwDecoder over many runs', () => {
  const RUNS = 12;

  test('noise alone, at any level, gives no text and no signal', () => {
    for (const noise of [0.003, 0.01, 0.03, 0.1]) {
      for (let run = 0; run < RUNS; run++) {
        const decoder = new CwDecoder(700);
        const text = decode(decoder, cwAudio('', { wpm: 20, noise, tail: 8 }));
        expect(text.trim(), `noise ${noise}`).toBe('');
        expect(decoder.status().signal, `noise ${noise}`).toBe(false);
      }
    }
  });

  test('keying in noise is read whole, and the signal is let go after', () => {
    for (let run = 0; run < RUNS; run++) {
      const decoder = new CwDecoder(700);
      const text = decode(
        decoder,
        cwAudio('CQ CQ DE K1ABC K', { wpm: 25, amplitude: 0.1, noise: 0.02, tail: 1.5 }),
      );
      expect(text.trim()).toBe('CQ CQ DE K1ABC K');
      expect(decoder.status().signal).toBe(false);
    }
  });

  test('a change of speed is followed', () => {
    for (let run = 0; run < RUNS; run++) {
      const decoder = new CwDecoder(700);
      decode(decoder, cwAudio('CQ CQ DE K1ABC', { wpm: 15 }));
      const faster = decode(decoder, cwAudio('K1ABC K', { wpm: 22, lead: 0.5 }));
      expect(faster.trim()).toBe('K1ABC K');
    }
  });

  test('a step up in the noise is taken in its stride', () => {
    let garbage = 0;
    let misread = 0;
    for (let run = 0; run < RUNS; run++) {
      const decoder = new CwDecoder(700);
      let text = decode(decoder, cwAudio('', { wpm: 20, noise: 0.005, tail: 4 }));
      text += decode(decoder, cwAudio('', { wpm: 20, noise: 0.03, tail: 4 }));
      const keyed = decode(decoder, cwAudio('TEST', { wpm: 20, noise: 0.03, tail: 1.5 }));
      // The floor follows a jump within a dah or so; a few characters of noise may be read
      // meanwhile, and must not spoil what is keyed after.
      if (text.trim().length > 5) garbage++;
      if (keyed.trim() !== 'TEST') misread++;
    }
    expect(garbage).toBeLessThanOrEqual(3);
    expect(misread).toBeLessThanOrEqual(1);
  });
});

describe('CwDecoder on the air', () => {
  // 26 s of the ZS1TEN/B beacon on 28.222 MHz, as the FT-710 delivered it in CW-U with its
  // pitch at 700 Hz: about 20 dB over the noise in the detector's bandwidth, at 12.6 WPM.
  const recording = readFileSync(new URL('./fixtures/beacon-zs1ten.wav', import.meta.url));
  const audio = new Uint8Array(recording.buffer, recording.byteOffset + 44, recording.length - 44);

  test('reads the beacon with the radio’s pitch', () => {
    const decoder = new CwDecoder(700);
    expect(decode(decoder, audio).trim()).toBe('VVV DE ZS1TEN/B JF96FA');
  });

  test('reads the beacon with its own search', () => {
    const decoder = new CwDecoder(null);
    expect(decode(decoder, audio).trim()).toBe('VVV DE ZS1TEN/B JF96FA');
  });
});
