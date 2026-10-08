import type { ScopeFrame } from '@radiobench/protocol';
import { FRAME_LENGTH, FRAME_TAIL, indexOfTail, parseScopeFrame } from './frame.ts';
import type { ScopeSource } from './source.ts';

/** Unusable reads in a row after which the stream is given up on: about half a second's worth. */
const MAX_BAD_READS = 20;

const NOTHING = new Uint8Array(0);

/**
 * Reads the scope stream as frames, until the signal aborts.
 *
 * The stream is a bare sequence of 4096-byte frames, so a read normally yields exactly one.
 * When it does not (the stream is corrupted while the radio transmits, and can come back
 * shifted), the frame tail shows where the frames really end and the reads are shifted to
 * match. Throws when no intact frame turns up for MAX_BAD_READS reads; reopening the port is
 * then the caller's remedy.
 */
export async function* readFrames(
  source: ScopeSource,
  signal: AbortSignal,
): AsyncGenerator<ScopeFrame> {
  // The first byte read after opening the port is not reliable, so that frame is dropped.
  await source.read(FRAME_LENGTH);

  let badReads = 0;
  // The end of the previous unusable read, kept so that a tail split across two reads is found.
  let carry: Uint8Array = NOTHING;
  while (!signal.aborted) {
    const bytes = await source.read(FRAME_LENGTH);
    const frame = parseScopeFrame(bytes);
    if (frame) {
      badReads = 0;
      carry = NOTHING;
      yield frame;
      continue;
    }
    if (++badReads >= MAX_BAD_READS) throw new Error('No valid scope data from the radio');

    const tailAt = indexOfTail(Buffer.concat([carry, bytes]));
    // Where the next frame starts within this read, if a tail shows it.
    const boundary = tailAt < 0 ? FRAME_LENGTH : tailAt - carry.length + FRAME_TAIL.length;
    if (boundary < FRAME_LENGTH) {
      // The rest of this read is the start of the next frame: skip what remains of that frame.
      await source.read(boundary);
      carry = NOTHING;
    } else {
      carry = bytes.subarray(FRAME_LENGTH - (FRAME_TAIL.length - 1));
    }
  }
}
