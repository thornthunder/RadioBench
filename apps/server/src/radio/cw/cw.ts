import { AUDIO_SAMPLE_RATE, type CwState } from '@radiobench/protocol';
import { MORSE } from './morse.ts';

/** Audio is weighed in blocks this long; a dit at 60 words per minute is two of them. */
const BLOCK_MS = 10;
const BLOCK = (AUDIO_SAMPLE_RATE * BLOCK_MS) / 1000;
/**
 * A keyed tone must stand this far above the noise to be decoded at all; once it is, it is
 * followed down to the lower figure, so that a signal near the edge does not flicker.
 */
const MIN_CONTRAST_DB = 18;
const KEEP_CONTRAST_DB = 14;
/**
 * The tone is taken as keyed above this share of the way from noise to peak, and off below
 * the other; never closer to the noise than the margins, which noise alone does not reach.
 * The margins are for a level judged block by block; averaged over w blocks, the noise
 * spreads less, by about the square root of w, down to the lesser margins.
 */
const ON_SHARE = 0.55;
const OFF_SHARE = 0.45;
const ON_MARGIN_DB = 14;
const OFF_MARGIN_DB = 8;
const LEAST_ON_MARGIN_DB = 11;
const LEAST_OFF_MARGIN_DB = 6;
/** The most blocks the level is averaged over: a quarter of a dit at 5 words per minute. */
const MAX_WINDOW = 6;
/** Marks and spaces shorter than this are keying noise, not elements. */
const MIN_ELEMENT_BLOCKS = 2;
/** A mark that never gets this share of the way from the noise to the peak is noise, not keying. */
const MARK_SHARE = 0.7;
/** How long the loudest level is remembered: longer than any space within keyed text. */
const PEAK_WINDOW_BLOCKS = 1000 / BLOCK_MS;
/**
 * How long the quietest levels are remembered: keyed text that long always holds gaps
 * between characters, even a slow sender's run of dahs.
 */
const FLOOR_WINDOW_BLOCKS = 3000 / BLOCK_MS;
/** The share of the quietest levels that makes the floor: a fifth of keyed text at least is space. */
const FLOOR_SHARE = 0.15;
/** How much must have been heard before the levels say anything. */
const MIN_HISTORY_BLOCKS = 30;
/**
 * The floor is stale when the quietest of this much of the recent past stands this far above
 * it: longer than a dah at 6 words per minute, so that keyed text always has a gap in it.
 */
const QUIET_WINDOW_BLOCKS = 600 / BLOCK_MS;
const STALE_FLOOR_DB = 6;
/** Where the tone is looked for when the radio does not say. */
const SEARCH_HZ = { from: 400, to: 1000, step: 50 };
/** The bounds of a plausible dit: 60 down to 5 words per minute. */
const MIN_DIT_MS = 20;
const MAX_DIT_MS = 240;
/** How many marks are heard before their lengths are trusted to tell dits from dahs. */
const WARM_UP_MARKS = 6;

/**
 * The dit length that the first marks agree on best: the one that most of them are a dit or
 * a dah of, give or take a third. A stray short mark of noise among them is thus outvoted,
 * where the shortest mark would have been taken for the dit.
 */
function ditAmong(marks: number[]): number {
  let best = Math.min(...marks);
  let support = 0;
  for (const candidate of marks) {
    const fits = marks.filter(
      (mark) =>
        Math.abs(mark / candidate - 1) < 0.35 || Math.abs(mark / (3 * candidate) - 1) < 0.35,
    ).length;
    if (fits > support || (fits === support && candidate < best)) {
      best = candidate;
      support = fits;
    }
  }
  return best;
}

/** A tone detector: Goertzel's algorithm over one block, and what it has seen so far. */
class Tone {
  readonly hz: number;
  private readonly coefficient: number;
  /**
   * The level is averaged over the last `window` blocks, in dB so that the edges of the
   * keying stay where they are: the slower the sender, the more blocks there is time for,
   * and the less the noise spreads.
   */
  window = 1;
  private readonly lastDb = new Float32Array(MAX_WINDOW).fill(-120);
  private readonly lastPower = new Float32Array(MAX_WINDOW);
  private lastAt = 0;
  /** The tone's quiet and loud levels lately, in dB. */
  floorDb = 0;
  peakDb = -120;
  /** The levels of the last while: the floor comes from the quietest of them, the peak is the loudest. */
  private readonly recent = new Float32Array(FLOOR_WINDOW_BLOCKS);
  private readonly sorted = new Float32Array(FLOOR_WINDOW_BLOCKS);
  private next = 0;
  /** How much of the window has been heard so far. */
  private filled = 0;

  constructor(hz: number) {
    this.hz = hz;
    this.coefficient = 2 * Math.cos((2 * Math.PI * hz) / AUDIO_SAMPLE_RATE);
  }

  /** The tone's level after the block, in dB, with the trackers moved along. */
  measure(block: Float32Array): number {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < block.length; i++) {
      const s0 = (block[i] ?? 0) + this.coefficient * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = (s1 * s1 + s2 * s2 - this.coefficient * s1 * s2) / (block.length * block.length);
    // The keying is judged on the level of the last few blocks averaged in dB: a mean of
    // levels keeps the edges of the keying in place, where a mean of powers would move them,
    // and the more blocks the less noise alone looks like keying. The floor and the peak are
    // tracked on the power averaged over at least two blocks, whose spread for noise alone
    // is known to keep below the gates.
    this.lastDb[this.lastAt] = 10 * Math.log10(power + 1e-12);
    this.lastPower[this.lastAt] = power;
    this.lastAt = (this.lastAt + 1) % MAX_WINDOW;
    let db = 0;
    let tracked = 0;
    const span = Math.max(2, this.window);
    for (let i = 1; i <= span; i++) {
      const at = (this.lastAt - i + MAX_WINDOW) % MAX_WINDOW;
      if (i <= this.window) db += this.lastDb[at] ?? -120;
      tracked += this.lastPower[at] ?? 0;
    }
    db /= this.window;
    this.recent[this.next] = 10 * Math.log10(tracked / span + 1e-12);
    this.next = (this.next + 1) % FLOOR_WINDOW_BLOCKS;
    this.filled = Math.min(this.filled + 1, FLOOR_WINDOW_BLOCKS);
    // The statistics are of what has been heard so far; until that is a fair sample, the
    // floor and the peak are kept together, and nothing is a signal.
    if (this.filled < MIN_HISTORY_BLOCKS) {
      this.floorDb = db;
      this.peakDb = db;
      return db;
    }
    // The peak is the loudest level of the last second: it holds through any space of the
    // keying, and a second after the last mark it is gone outright, with no slow fade during
    // which noise could pass for keying.
    let peak = -120;
    let quietest = 0;
    for (let age = 0; age < Math.min(PEAK_WINDOW_BLOCKS, this.filled); age++) {
      const index = (this.next - 1 - age + FLOOR_WINDOW_BLOCKS) % FLOOR_WINDOW_BLOCKS;
      const level = this.recent[index] ?? -120;
      peak = Math.max(peak, level);
      if (age < QUIET_WINDOW_BLOCKS) quietest = Math.min(quietest, level);
    }
    this.peakDb = peak;
    // The floor is the quietest part of the last second and a half, which keyed text always
    // has spaces in: the mean of its lowest levels rather than the very lowest, which noise
    // alone would stand too far above. It follows a rise in the noise within that time,
    // rather than creeping after it while the noise is read as keying.
    const sorted = this.sorted.subarray(0, this.filled);
    sorted.set(this.recent.subarray(0, this.filled));
    sorted.sort();
    const share = Math.max(1, Math.round(this.filled * FLOOR_SHARE));
    let floor = 0;
    for (let i = 0; i < share; i++) floor += sorted[i] ?? 0;
    floor /= share;
    // Keyed text always has a gap within a dah and a bit. When even the quietest block of
    // that much of the recent past stands well above the floor, the noise has risen: the
    // floor follows at once rather than over the whole window, during which noise would be
    // read as keying.
    if (quietest > floor + STALE_FLOOR_DB) floor = quietest;
    this.floorDb = floor;
    return db;
  }

  get contrastDb(): number {
    return this.peakDb - this.floorDb;
  }
}

/**
 * Decodes Morse from the received audio: finds the tone, follows the keying, learns the
 * sender's speed from it, and turns marks and spaces into text. Given the radio's own CW
 * pitch it sits on that; otherwise it looks for the strongest keyed tone itself.
 */
export class CwDecoder {
  private pitch: Tone;
  private fixedPitch: number | null;
  private readonly search: Tone[];
  private readonly block = new Float32Array(BLOCK);
  private filled = 0;
  private blocks = 0;

  // The keying as followed: whether the tone is on, for how many blocks so far, and for how
  // many blocks it has looked like changing.
  private keyed = false;
  private run = 0;
  private pending = 0;
  /** The loudest block of the mark under way, and the length of the space before it. */
  private markPeakDb = -120;
  private spaceBefore = 0;
  private signal = false;
  /** Whether a keyed tone has been found at all, when looking for one. */
  private found = false;
  // The sender's timing.
  private ditMs = 0;
  private warmUp: { mark: number; space: number }[] = [];
  // The character under way, and what the current space has already been taken for.
  private symbol = '';
  private characterDone = false;
  private wordDone = true;

  constructor(pitchHz: number | null = null) {
    this.fixedPitch = pitchHz;
    this.pitch = new Tone(pitchHz ?? 700);
    this.search = [];
    for (let hz = SEARCH_HZ.from; hz <= SEARCH_HZ.to; hz += SEARCH_HZ.step) {
      this.search.push(new Tone(hz));
    }
  }

  /** Decodes at this tone from now on; null lets the decoder look for the tone itself. */
  setPitch(pitchHz: number | null): void {
    if (pitchHz === this.fixedPitch) return;
    this.fixedPitch = pitchHz;
    if (pitchHz !== null) this.retune(pitchHz);
  }

  status(): CwState {
    return {
      wpm: this.signal && this.ditMs > 0 ? Math.round(1200 / this.ditMs) : null,
      pitchHz: this.fixedPitch !== null || this.found ? this.pitch.hz : null,
      signal: this.signal,
    };
  }

  /** Takes in 16-bit little-endian samples and returns whatever text they completed. */
  feed(samples: Uint8Array): string {
    let text = '';
    const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
    for (let i = 0; i + 1 < samples.length; i += 2) {
      this.block[this.filled++] = view.getInt16(i, true) / 32768;
      if (this.filled === BLOCK) {
        this.filled = 0;
        text += this.processBlock();
      }
    }
    return text;
  }

  private processBlock(): string {
    this.blocks++;
    const db = this.pitch.measure(this.block);
    if (this.fixedPitch === null) this.lookForTone();

    const contrast = this.pitch.contrastDb;
    this.signal = contrast >= (this.signal ? KEEP_CONTRAST_DB : MIN_CONTRAST_DB);
    if (this.signal) this.found = true;
    if (!this.signal) {
      // Nothing to follow: whatever was under way is closed, mid-character or not, and
      // marks heard before the speed was known are not to be trusted.
      const rest = this.finishCharacter() + this.finishWord();
      this.keyed = false;
      this.run = 0;
      this.pending = 0;
      this.warmUp = [];
      return rest;
    }
    const floor = this.pitch.floorDb;
    const spread = 1 / Math.sqrt(this.pitch.window);
    const onMargin = Math.max(LEAST_ON_MARGIN_DB, ON_MARGIN_DB * spread);
    const offMargin = Math.max(LEAST_OFF_MARGIN_DB, OFF_MARGIN_DB * spread);
    const keyed = this.keyed
      ? db > floor + Math.max(OFF_SHARE * contrast, offMargin)
      : db > floor + Math.max(ON_SHARE * contrast, onMargin);
    if (this.keyed || keyed) this.markPeakDb = Math.max(this.markPeakDb, db);
    if (keyed === this.keyed) {
      // Still the same, and any blocks that looked like a change were a glitch.
      this.run += 1 + this.pending;
      this.pending = 0;
      return this.keyed ? '' : this.spaceSoFar();
    }
    // A change only counts once it has lasted as long as the shortest element.
    this.pending++;
    if (this.pending < MIN_ELEMENT_BLOCKS) return '';
    let text = '';
    if (this.keyed) {
      if (this.markPeakDb < floor + MARK_SHARE * contrast) {
        // Too faint for keying: noise in a space, which carries on as if nothing happened.
        this.keyed = false;
        this.run += this.spaceBefore + this.pending;
        this.pending = 0;
        return '';
      }
      text = this.endMark(this.run);
    } else {
      text = this.endSpace(this.run);
      this.spaceBefore = this.run;
      this.markPeakDb = -120;
    }
    this.keyed = keyed;
    this.run = this.pending;
    this.pending = 0;
    return text;
  }

  /**
   * Every second, a clearly stronger keyed tone wins over the one being followed. Only a
   * tone that is a signal in its own right counts: while a sender pauses, the noise in the
   * other bins must not draw the decoder away from where the sender will go on.
   */
  private lookForTone(): void {
    for (const tone of this.search) tone.measure(this.block);
    if (this.blocks % 100 !== 0) return;
    let best = this.search[0]!;
    for (const tone of this.search) if (tone.contrastDb > best.contrastDb) best = tone;
    if (
      best.hz !== this.pitch.hz &&
      best.contrastDb >= MIN_CONTRAST_DB &&
      best.contrastDb > this.pitch.contrastDb + 4
    ) {
      this.retune(best.hz);
    }
  }

  private retune(hz: number): void {
    this.pitch = new Tone(hz);
    this.setWindow(1);
    this.symbol = '';
    this.warmUp = [];
    this.ditMs = 0;
    this.keyed = false;
    this.run = 0;
    this.pending = 0;
  }

  /** A mark has ended: a dit or a dah, which also teaches the sender's speed. */
  private endMark(blocks: number): string {
    const ms = blocks * BLOCK_MS;
    if (this.ditMs === 0) {
      // The first marks are kept until there are enough to tell the short from the long.
      this.warmUp.push({ mark: ms, space: 0 });
      if (this.warmUp.length < WARM_UP_MARKS) return '';
      this.ditMs = Math.max(MIN_DIT_MS, ditAmong(this.warmUp.map((e) => e.mark)));
      const kept = this.warmUp;
      this.warmUp = [];
      let text = '';
      for (const element of kept) {
        text += this.classify(element.mark);
        if (element.space > 0) text += this.endSpace(element.space / BLOCK_MS);
      }
      return text;
    }
    return this.classify(ms);
  }

  private classify(ms: number): string {
    // A dah is three dits: the line between them lies at their geometric mean, which treats
    // a sender speeding up and one slowing down alike. A mark near the line still teaches
    // the speed, if less than a clear dit or dah does.
    const ratio = ms / this.ditMs;
    if (ratio < Math.sqrt(3)) {
      this.symbol += '.';
      this.ditMs = Math.max(MIN_DIT_MS, this.ditMs + (ratio < 1.3 ? 0.4 : 0.2) * (ms - this.ditMs));
    } else {
      this.symbol += '-';
      const dit = ms / 3;
      this.ditMs = Math.min(
        MAX_DIT_MS,
        this.ditMs + (ratio > 2.5 ? 0.15 : 0.2) * (dit - this.ditMs),
      );
    }
    this.characterDone = false;
    this.wordDone = false;
    // A slower sender leaves time to average the level over more blocks: a quarter of a dit.
    this.setWindow(Math.max(1, Math.min(MAX_WINDOW, Math.round(this.ditMs / (4 * BLOCK_MS)))));
    return '';
  }

  private setWindow(blocks: number): void {
    this.pitch.window = blocks;
    for (const tone of this.search) tone.window = blocks;
  }

  /** A space has ended because a mark began; its length may close a character or a word. */
  private endSpace(blocks: number): string {
    if (this.ditMs === 0) {
      const last = this.warmUp[this.warmUp.length - 1];
      if (last) last.space = blocks * BLOCK_MS;
      return '';
    }
    const ms = blocks * BLOCK_MS;
    let text = '';
    if (ms >= 2 * this.ditMs) text += this.finishCharacter();
    if (ms >= 5 * this.ditMs) text += this.finishWord();
    return text;
  }

  /** While a space goes on, the character and then the word are closed as it lengthens. */
  private spaceSoFar(): string {
    if (this.ditMs === 0) return '';
    const ms = this.run * BLOCK_MS;
    let text = '';
    if (!this.characterDone && ms >= 2.5 * this.ditMs) text += this.finishCharacter();
    if (!this.wordDone && ms >= 6 * this.ditMs) text += this.finishWord();
    return text;
  }

  private finishCharacter(): string {
    this.characterDone = true;
    if (this.symbol === '') return '';
    const character = MORSE[this.symbol] ?? '¿';
    this.symbol = '';
    return character;
  }

  private finishWord(): string {
    if (this.wordDone) return '';
    this.wordDone = true;
    return ' ';
  }
}
