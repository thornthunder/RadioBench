import { setTimeout as sleep } from 'node:timers/promises';
import { SCOPE_BINS } from '@radiobench/protocol';
import { FRAME_LENGTH, FRAME_TAIL } from './frame.ts';
import type { ScopeSource } from './source.ts';

const FRAME_INTERVAL_MS = 33;
const SPAN_HZ = 100_000;
const SPAN_INDEX = 6;
const CENTRE_MODE = 4;
const NOISE_FLOOR = 60;
/** Simulated stations sit on this grid of absolute frequencies, so tuning moves them across the sweep. */
const STATION_SPACING_HZ = 7_000;

/** A repeatable pseudo-random value in 0..1 for a whole number. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A stand-in for the radio's scope port: frames in the real layout, with a noise floor and a
 * few stations that come and go, centred on whatever frequency the radio is tuned to.
 */
export class SimulatedScopeSource implements ScopeSource {
  private readonly frequencyHz: () => number | null;

  constructor(frequencyHz: () => number | null) {
    this.frequencyHz = frequencyHz;
  }

  async open(): Promise<void> {}

  async read(length: number): Promise<Uint8Array> {
    if (length !== FRAME_LENGTH) return new Uint8Array(length);
    await sleep(FRAME_INTERVAL_MS);
    return this.frame(this.frequencyHz() ?? 14_074_000, Date.now());
  }

  async close(): Promise<void> {}

  private frame(centreHz: number, now: number): Uint8Array {
    const frame = Buffer.alloc(FRAME_LENGTH);
    const startHz = centreHz - SPAN_HZ / 2;
    const binHz = SPAN_HZ / SCOPE_BINS;
    for (let bin = 0; bin < SCOPE_BINS; bin++) {
      const hz = startHz + (bin + 0.5) * binHz;
      const station = Math.round(hz / STATION_SPACING_HZ);
      const offsetHz = Math.abs(hz - station * STATION_SPACING_HZ);
      // Each station keys on and off in its own rhythm and has its own strength.
      const keyed = hash(station * 31 + Math.floor(now / (2_000 + 3_000 * hash(station)))) > 0.45;
      const peak = keyed ? 40 + 90 * hash(station + 0.5) : 0;
      const signal = peak * Math.exp(-((offsetHz / 400) ** 2));
      const level = NOISE_FLOOR + signal + 14 * Math.random();
      frame[bin] = 255 - Math.min(255, Math.round(level));
    }

    // A tone in the audio, for the MULTI view: a peak in the spectrum and a wave on the trace.
    for (let bin = 0; bin < 200; bin++) {
      const level = 50 + 150 * Math.exp(-(((bin - 35) / 3) ** 2)) + 12 * Math.random();
      frame[1700 + bin] = 255 - Math.round(level);
    }
    for (let column = 0; column < 200; column++) {
      const height = 128 + 70 * Math.sin(now / 90 + column * 0.22);
      frame[1900 + column * 2] = Math.round(height + 6);
      frame[1901 + column * 2] = Math.round(height - 6);
    }

    const status = frame.subarray(2900);
    status[17] = CENTRE_MODE;
    status[32] = SPAN_INDEX;
    status[110] = 70 + Math.round(20 * Math.sin(now / 900));
    // VFO-A as ten BCD digits.
    Buffer.from(String(centreHz).padStart(10, '0'), 'hex').copy(status, 64);
    status.writeUInt32BE(centreHz, 132);
    FRAME_TAIL.copy(frame, FRAME_LENGTH - FRAME_TAIL.length);
    return frame;
  }
}
