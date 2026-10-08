import { readFileSync } from 'node:fs';
import type { ScopeFrame } from '@radiobench/protocol';
import { expect, test } from 'vitest';
import { FRAME_LENGTH } from './frame.ts';
import { readFrames } from './reader.ts';
import type { ScopeSource } from './source.ts';

const captured = readFileSync(new URL('./fixtures/ft710-frame.bin', import.meta.url));

/** A copy of the captured frame whose first sweep point carries a number, to tell frames apart. */
function numbered(n: number): Buffer {
  const frame = Buffer.from(captured);
  frame[0] = 255 - n;
  return frame;
}

/** A scope port that plays back the given bytes and then fails, as a pulled cable would. */
function playback(stream: Buffer): ScopeSource {
  let at = 0;
  return {
    open: async () => {},
    close: async () => {},
    read: async (length) => {
      if (at + length > stream.length) throw new Error('end of recording');
      at += length;
      return stream.subarray(at - length, at);
    },
  };
}

/** Reads frames until the recording ends; returns the numbers of the frames that came out. */
async function framesFrom(stream: Buffer): Promise<{ numbers: number[]; error: string }> {
  const frames: ScopeFrame[] = [];
  try {
    for await (const frame of readFrames(playback(stream), new AbortController().signal)) {
      frames.push(frame);
    }
  } catch (error) {
    return { numbers: frames.map((frame) => frame.bins[0]!), error: (error as Error).message };
  }
  throw new Error('the reader stopped without an error');
}

test('yields every frame of an aligned stream after the first', async () => {
  const stream = Buffer.concat([numbered(0), numbered(1), numbered(2), numbered(3)]);
  expect(await framesFrom(stream)).toEqual({ numbers: [1, 2, 3], error: 'end of recording' });
});

test.each([1, 8, 16, 2000, 4090])('realigns a stream shifted by %i bytes', async (shift) => {
  const frames = [0, 1, 2, 3, 4, 5, 6, 7].map(numbered);
  const stream = Buffer.concat(frames).subarray(shift);
  const { numbers } = await framesFrom(stream);
  // A few frames are lost while the boundary is found; from then on every frame comes out whole.
  expect(numbers.length).toBeGreaterThanOrEqual(4);
  expect(numbers.at(-1)).toBe(7);
  expect(numbers).toEqual(numbers.map((_, i) => numbers[0]! + i));
});

test('drops a corrupt frame without losing its neighbours', async () => {
  const corrupt = numbered(2);
  corrupt.fill(0x55, 3000);
  const stream = Buffer.concat([numbered(0), numbered(1), corrupt, numbered(3), numbered(4)]);
  expect((await framesFrom(stream)).numbers).toEqual([1, 3, 4]);
});

test('gives up when the stream stays unusable', async () => {
  const noise = Buffer.alloc(FRAME_LENGTH * 40, 0x55);
  expect(await framesFrom(noise)).toEqual({
    numbers: [],
    error: 'No valid scope data from the radio',
  });
});
