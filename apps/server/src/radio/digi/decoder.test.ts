import { AUDIO_SAMPLE_RATE, type AudioState, type DigiMode } from '@radiobench/protocol';
import { expect, test } from 'vitest';
import { Decoder, type AudioSource, type DecodeEngine } from './decoder.ts';

/** An audio source fed by hand. */
class FakeSource implements AudioSource {
  state: AudioState = { status: 'ready', detail: null, canTalk: false, talking: false };
  listeners = new Set<(samples: Uint8Array) => void>();
  stateListeners = new Set<(state: AudioState) => void>();
  getState() {
    return this.state;
  }
  onState(listener: (state: AudioState) => void) {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }
  listen(listener: (samples: Uint8Array) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** Hands over a chunk of 16-bit silence, or the given sample value. */
  feed(samples: number, value = 0) {
    const bytes = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) bytes.writeInt16LE(value, i * 2);
    for (const listener of this.listeners) listener(bytes);
  }
  become(status: AudioState['status'], detail: string | null = null) {
    this.state = { ...this.state, status, detail };
    for (const listener of this.stateListeners) listener(this.state);
  }
}

/** Records what it is asked to decode and answers with one made-up decode per slot. */
class FakeEngine implements DecodeEngine {
  readonly depth = 2;
  readonly threads = 1;
  calls: { mode: DigiMode; samples: Float32Array; slotStart: number }[] = [];
  closed = false;
  async decode(mode: DigiMode, samples: Float32Array, slotStart: number) {
    this.calls.push({ mode, samples, slotStart });
    return [{ snr: -5, dt: 0.1, hz: 1200, text: `CQ K1ABC FN42 ${slotStart}` }];
  }
  close() {
    this.closed = true;
  }
}

/** A clock that is moved by hand, starting at a slot boundary. */
function clock(startMs: number) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

const CHUNK_MS = 20;
const CHUNK_SAMPLES = (AUDIO_SAMPLE_RATE * CHUNK_MS) / 1000;

/** Feeds a whole slot's worth of audio in 20 ms chunks, moving the clock along. */
function feedSlot(source: FakeSource, time: ReturnType<typeof clock>, slotMs: number, value = 0) {
  for (let t = 0; t < slotMs; t += CHUNK_MS) {
    source.feed(CHUNK_SAMPLES, value);
    time.advance(CHUNK_MS);
  }
}

function setUp(mode: DigiMode = 'FT8') {
  const source = new FakeSource();
  const engine = new FakeEngine();
  const time = clock(1_700_000_000_000 - (1_700_000_000_000 % 15_000) + 5_000); // 5 s into a slot
  const decoder = new Decoder(source, engine, {
    mode,
    now: time.now,
    dial: () => ({ hz: 14_074_000, mode: 'DATA-U' }),
  });
  return { source, engine, time, decoder };
}

test('audio is captured only while someone uses the decoder', () => {
  const { source, decoder } = setUp();
  expect(decoder.getState()).toMatchObject({ status: 'idle', mode: 'FT8', depth: 2 });
  expect(source.listeners.size).toBe(0);

  const releaseFirst = decoder.use();
  const releaseSecond = decoder.use();
  expect(source.listeners.size).toBe(1);
  expect(decoder.getState().status).toBe('running');

  releaseFirst();
  releaseFirst(); // releasing twice is harmless
  expect(source.listeners.size).toBe(1);
  releaseSecond();
  expect(source.listeners.size).toBe(0);
  expect(decoder.getState().status).toBe('idle');
});

test('each whole slot is decoded with its start time and what the radio was tuned to', async () => {
  const { source, engine, time, decoder } = setUp();
  const batches: unknown[] = [];
  decoder.onBatch((batch) => batches.push(batch));
  decoder.use();

  // The slot joined 5 s in is not decoded: too much of it was missed.
  feedSlot(source, time, 10_000);
  // Two whole slots follow.
  feedSlot(source, time, 15_000, 1000);
  feedSlot(source, time, 15_000);
  // The decode is handed over when the next slot's first chunk arrives.
  source.feed(CHUNK_SAMPLES);
  await expect.poll(() => batches.length).toBe(2);

  expect(engine.calls).toHaveLength(2);
  const first = engine.calls[0]!;
  expect(first.mode).toBe('FT8');
  expect(first.slotStart % 15_000).toBe(0);
  expect(first.samples.length).toBe(15 * AUDIO_SAMPLE_RATE);
  expect(first.samples[0]).toBeCloseTo(1000 / 32768);
  expect(engine.calls[1]!.slotStart - first.slotStart).toBe(15_000);
  expect(batches[0]).toEqual({
    mode: 'FT8',
    slotStart: first.slotStart,
    dialHz: 14_074_000,
    radioMode: 'DATA-U',
    decodes: [{ snr: -5, dt: 0.1, hz: 1200, text: `CQ K1ABC FN42 ${first.slotStart}` }],
  });
  expect(decoder.recent()).toEqual(batches);
});

test('switching mode drops the slot under way and cuts the next ones at the new length', async () => {
  const { source, engine, time, decoder } = setUp();
  decoder.use();
  feedSlot(source, time, 10_000); // to the boundary
  feedSlot(source, time, 7_000); // 7 s into a whole FT8 slot...
  decoder.setMode('FT4'); // ...which is dropped
  expect(decoder.getState().mode).toBe('FT4');
  feedSlot(source, time, 8_000); // the rest of the 15 s: an FT4 slot ends at 7.5 s
  feedSlot(source, time, 7_500);
  source.feed(CHUNK_SAMPLES);
  await expect.poll(() => engine.calls.length).toBeGreaterThanOrEqual(1);
  expect(engine.calls.every((call) => call.mode === 'FT4')).toBe(true);
  expect(engine.calls.every((call) => call.slotStart % 7_500 === 0)).toBe(true);
  expect(engine.calls[0]!.samples.length).toBe(7.5 * AUDIO_SAMPLE_RATE);
});

test('the decoder is as available as the audio, and stopping ends the engine', () => {
  const { source, engine, decoder } = setUp();
  decoder.use();
  source.become('unavailable', 'No recording device named "USB Audio Device" was found');
  expect(decoder.getState()).toMatchObject({
    status: 'unavailable',
    detail: 'No recording device named "USB Audio Device" was found',
  });
  source.become('ready');
  expect(decoder.getState()).toMatchObject({ status: 'running', detail: null });

  decoder.stop();
  expect(decoder.getState().status).toBe('idle');
  expect(engine.closed).toBe(true);
  expect(source.listeners.size).toBe(0);
});

test('without audio the decoder is off and stays off', () => {
  const source = new FakeSource();
  source.state = { status: 'off', detail: null, canTalk: false, talking: false };
  const decoder = new Decoder(source, new FakeEngine(), { dial: () => ({ hz: null, mode: null }) });
  expect(decoder.getState().status).toBe('off');
  decoder.use();
  expect(decoder.getState().status).toBe('off');
  expect(source.listeners.size).toBe(0);
});
