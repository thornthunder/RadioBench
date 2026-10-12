import { AUDIO_SAMPLE_RATE, type CwState } from '@radiobench/protocol';
import { MORSE } from './morse.ts';

/** Audio is weighed in blocks this long; a dit at 60 words per minute is two of them. */
const BLOCK_MS = 10;
const BLOCK = (AUDIO_SAMPLE_RATE * BLOCK_MS) / 1000;
/** A keyed tone must stand this far above the noise to be decoded at all. */
const MIN_CONTRAST_DB = 18;
/**
 * The tone is taken as keyed above this share of the way from noise to peak, and off below
 * the other; never closer to the noise than the margins, which noise alone does not reach.
 */
const ON_SHARE = 0.55;
const OFF_SHARE = 0.45;
const ON_MARGIN_DB = 14;
const OFF_MARGIN_DB = 8;
/** Marks and spaces shorter than this are keying noise, not elements. */
const MIN_ELEMENT_BLOCKS = 2;
/** A mark that never comes within this of the recent peak is noise, not keying. */
const MARK_DEPTH_DB = 10;
/** How long the loudest level is remembered: longer than any space within keyed text. */
const PEAK_WINDOW_BLOCKS = 1000 / BLOCK_MS;
/** How long the quietest levels are remembered: keyed text that long always holds spaces. */
const FLOOR_WINDOW_BLOCKS = 1500 / BLOCK_MS;
/** The share of the quietest levels that makes the floor: a fifth of keyed text at least is space. */
const FLOOR_SHARE = 0.15;
/** How much must have been heard before the levels say anything. */
const MIN_HISTORY_BLOCKS = 30;
/** Where the tone is looked for when the radio does not say. */
const SEARCH_HZ = { from: 400, to: 1000, step: 50 };
/** The bounds of a plausible dit: 60 down to 5 words per minute. */
const MIN_DIT_MS = 20;
const MAX_DIT_MS = 240;
/** How many marks are heard before their lengths are trusted to tell dits from dahs. */
const WARM_UP_MARKS = 4;

/** A tone detector: Goertzel's algorithm over one block, and what it has seen so far. */
class Tone {
  readonly hz: number;
  private readonly coefficient: number;
  /** The power of the block before, and the tone's quiet and loud levels lately, in dB. */
  private previousPower = 0;
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
    // The trackers see the level averaged over two blocks, so that noise alone does not look
    // like keying; the keying itself is judged on the block as it is, which keeps marks and
    // spaces their true length.
    const db = 10 * Math.log10((power + this.previousPower) / 2 + 1e-12);
    this.previousPower = power;
    this.recent[this.next] = db;
    this.next = (this.next + 1) % FLOOR_WINDOW_BLOCKS;
    this.filled = Math.min(this.filled + 1, FLOOR_WINDOW_BLOCKS);
    // The statistics are of what has been heard so far; until that is a fair sample, the
    // floor and the peak are kept together, and nothing is a signal.
    if (this.filled < MIN_HISTORY_BLOCKS) {
      this.floorDb = db;
      this.peakDb = db;
      return 10 * Math.log10(power + 1e-12);
    }
    // The peak is the loudest level of the last second: it holds through any space of the
    // keying, and a second after the last mark it is gone outright, with no slow fade during
    // which noise could pass for keying.
    let peak = -120;
    for (let age = 0; age < Math.min(PEAK_WINDOW_BLOCKS, this.filled); age++) {
      const index = (this.next - 1 - age + FLOOR_WINDOW_BLOCKS) % FLOOR_WINDOW_BLOCKS;
      peak = Math.max(peak, this.recent[index] ?? -120);
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
    this.floorDb = floor / share;
    return 10 * Math.log10(power + 1e-12);
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
    this.signal = contrast >= MIN_CONTRAST_DB;
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
    const keyed = this.keyed
      ? db > floor + Math.max(OFF_SHARE * contrast, OFF_MARGIN_DB)
      : db > floor + Math.max(ON_SHARE * contrast, ON_MARGIN_DB);
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
      if (this.markPeakDb < this.pitch.peakDb - MARK_DEPTH_DB) {
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

  /** Every second, the strongest keyed tone wins over the one being followed, if clearly so. */
  private lookForTone(): void {
    for (const tone of this.search) tone.measure(this.block);
    if (this.blocks % 100 !== 0) return;
    let best = this.search[0]!;
    for (const tone of this.search) if (tone.contrastDb > best.contrastDb) best = tone;
    if (best.hz !== this.pitch.hz && best.contrastDb > this.pitch.contrastDb + 3) {
      this.retune(best.hz);
    }
  }

  private retune(hz: number): void {
    this.pitch = new Tone(hz);
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
      this.ditMs = Math.max(MIN_DIT_MS, Math.min(...this.warmUp.map((e) => e.mark)));
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
    if (ms < 1.5 * this.ditMs) {
      this.symbol += '.';
      this.ditMs = Math.max(MIN_DIT_MS, this.ditMs + 0.4 * (ms - this.ditMs));
    } else if (ms > 2.5 * this.ditMs) {
      this.symbol += '-';
      this.ditMs = Math.min(MAX_DIT_MS, this.ditMs + 0.15 * (ms / 3 - this.ditMs));
    } else {
      // Between the two: nearer to a dit or to a dah, and no lesson taken from it.
      this.symbol += ms < 2 * this.ditMs ? '.' : '-';
    }
    this.characterDone = false;
    this.wordDone = false;
    return '';
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
