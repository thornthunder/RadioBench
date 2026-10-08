import { readFileSync } from 'node:fs';
import { SCOPE_BINS } from '@radiobench/protocol';
import { expect, test } from 'vitest';
import { FRAME_LENGTH, parseScopeFrame } from './frame.ts';

/**
 * A frame captured from an FT-710 tuned to 3.573 MHz, with the scope in centre mode and a
 * 500 kHz span.
 */
function capturedFrame(): Buffer {
  return readFileSync(new URL('./fixtures/ft710-frame.bin', import.meta.url));
}

test('decodes a frame captured from a real FT-710', () => {
  const raw = capturedFrame();
  const frame = parseScopeFrame(raw);
  expect(frame).toMatchObject({ startHz: 3_323_000, spanHz: 500_000 });
  expect(frame?.bins).toHaveLength(SCOPE_BINS);
  // The radio sends the sweep inverted.
  expect(frame?.bins[100]).toBe(255 - raw[100]!);
  expect(frame?.bins[849]).toBe(255 - raw[849]!);
  expect(frame?.sMeter).toBe(raw[2900 + 110]);
});

test('takes the audio spectrum and oscilloscope trace out of the frame', () => {
  const raw = capturedFrame();
  const frame = parseScopeFrame(raw);
  // The spectrum is inverted like the sweep: where the radio sent 255 there is nothing.
  expect(frame?.audioSpectrum).toHaveLength(200);
  expect(frame?.audioSpectrum[0]).toBe(255 - raw[1700]!);
  expect(frame?.audioSpectrum[199]).toBe(255 - raw[1899]!);
  // The trace comes as the two ends of a stroke per column, the upper one first.
  expect(frame?.audioWave).toHaveLength(400);
  expect([...(frame?.audioWave ?? [])]).toEqual([...raw.subarray(1900, 2300)]);
  const strokes = Array.from({ length: 200 }, (_, column) => [
    frame!.audioWave[column * 2]!,
    frame!.audioWave[column * 2 + 1]!,
  ]);
  expect(strokes.every(([upper, lower]) => upper! >= lower!)).toBe(true);
});

test('a cursor or fixed sweep starts at the frequency the frame names', () => {
  const raw = capturedFrame();
  const status = raw.subarray(2900);
  status[17] = 0x0a;
  status.writeUInt32BE(3_500_000, 144);
  expect(parseScopeFrame(raw)).toMatchObject({ startHz: 3_500_000, spanHz: 500_000 });
});

test('rejects anything that is not an intact frame', () => {
  expect(parseScopeFrame(capturedFrame().subarray(1))).toBeNull();

  const shifted = Buffer.concat([capturedFrame().subarray(8), Buffer.alloc(8)]);
  expect(parseScopeFrame(shifted)).toBeNull();

  const badFrequency = capturedFrame();
  badFrequency[2900 + 64] = 0xfa;
  expect(parseScopeFrame(badFrequency)).toBeNull();

  const badSpan = capturedFrame();
  badSpan[2900 + 32] = 10;
  expect(parseScopeFrame(badSpan)).toBeNull();

  expect(parseScopeFrame(Buffer.alloc(FRAME_LENGTH))).toBeNull();
});
