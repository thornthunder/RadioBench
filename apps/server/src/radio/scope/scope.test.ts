import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ScopeFrame } from '@radiobench/protocol';
import { afterEach, expect, test } from 'vitest';
import { Scope } from './scope.ts';
import { SimulatedScopeSource } from './simulator.ts';
import type { ScopeSource } from './source.ts';

const captured = readFileSync(new URL('./fixtures/ft710-frame.bin', import.meta.url));

let scope: Scope;

afterEach(() => scope.stop());

test('without a source the scope is off and stays off', () => {
  scope = new Scope(null);
  scope.start();
  expect(scope.getState()).toEqual({ status: 'off', detail: null });
});

test('the simulator produces sweeps centred on the tuned frequency', async () => {
  scope = new Scope(() => new SimulatedScopeSource(() => 7_074_000));
  const frames: ScopeFrame[] = [];
  scope.onFrame((frame) => frames.push(frame));
  scope.start();
  await expect.poll(() => frames.length).toBeGreaterThanOrEqual(3);
  expect(scope.getState()).toEqual({ status: 'running', detail: null });
  expect(frames[0]).toMatchObject({ startHz: 7_024_000, spanHz: 100_000 });
});

test('a sweep the radio repeats is passed on once', async () => {
  let reads = 0;
  const repeating: ScopeSource = {
    open: async () => {},
    close: async () => {},
    read: async () => {
      await sleep(1);
      // Every sweep is read three times over.
      const frame = Buffer.from(captured);
      frame[0] = Math.floor(reads++ / 3);
      return frame;
    },
  };
  scope = new Scope(() => repeating);
  const firstPoints: number[] = [];
  scope.onFrame((frame) => firstPoints.push(frame.bins[0]!));
  scope.start();
  await expect.poll(() => firstPoints.length).toBeGreaterThanOrEqual(4);
  expect(firstPoints.slice(0, 4)).toEqual(
    firstPoints.slice(0, 4).map((_, i) => firstPoints[0]! - i),
  );
});

test('says why the scope is unavailable, and recovers once the port can be opened', async () => {
  let attempts = 0;
  scope = new Scope(() => {
    if (++attempts > 1) return new SimulatedScopeSource(() => 7_074_000);
    return {
      open: async () => {
        throw new Error('The scope port of the radio was not found');
      },
      read: async () => new Uint8Array(0),
      close: async () => {},
    };
  });
  scope.start();
  await expect
    .poll(() => scope.getState())
    .toEqual({ status: 'unavailable', detail: 'The scope port of the radio was not found' });
  await expect.poll(() => scope.getState().status, { timeout: 5000 }).toBe('running');
}, 10_000);
