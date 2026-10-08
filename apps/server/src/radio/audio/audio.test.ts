import { AUDIO_SAMPLE_RATE } from '@radiobench/protocol';
import { afterEach, expect, test } from 'vitest';
import { Audio, SimulatedAudioDevice, type AudioDevice } from './audio.ts';

let audio: Audio;

afterEach(() => audio.stop());

/** A sound device that counts how it is used and can be made to fail. */
function countingDevice(failure?: string) {
  const device = new SimulatedAudioDevice();
  const counts = { opened: 0, closed: 0 };
  const spy: AudioDevice = {
    openInput: async () => {
      counts.opened++;
      if (failure) throw new Error(failure);
      await device.openInput();
    },
    read: () => device.read(),
    closeInput: () => void counts.closed++,
    openOutput: () => device.openOutput(),
    write: (samples) => device.write(samples),
    closeOutput: () => device.closeOutput(),
  };
  return { device, spy, counts };
}

test('without a device, audio is off', () => {
  audio = new Audio(null, true);
  expect(audio.getState()).toEqual({
    status: 'off',
    detail: null,
    canTalk: false,
    talking: false,
  });
  audio.listen(() => {})();
});

test('received audio arrives at about the rate it is sampled at', async () => {
  audio = new Audio(new SimulatedAudioDevice());
  let bytes = 0;
  // Timed from the first samples: opening the simulated device takes a moment of its own.
  let started = 0;
  audio.listen((samples) => {
    if (started === 0) started = performance.now();
    else bytes += samples.length;
  });
  await expect.poll(() => started).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const seconds = (performance.now() - started) / 1000;
  const rate = bytes / 2 / seconds;
  expect(rate).toBeGreaterThan(AUDIO_SAMPLE_RATE * 0.8);
  expect(rate).toBeLessThan(AUDIO_SAMPLE_RATE * 1.1);
});

test('the device is open only while someone listens', async () => {
  const { spy, counts } = countingDevice();
  audio = new Audio(spy);
  expect(counts.opened).toBe(0);

  let heard = 0;
  const first = audio.listen(() => heard++);
  const second = audio.listen(() => {});
  await expect.poll(() => heard).toBeGreaterThan(0);
  expect(counts).toEqual({ opened: 1, closed: 0 });

  first();
  expect(counts.closed).toBe(0);
  second();
  expect(counts.closed).toBe(1);
});

test('says why audio is unavailable when the device cannot be opened', async () => {
  const { spy } = countingDevice('No recording device named "USB Audio Device" was found');
  audio = new Audio(spy);
  const states: string[] = [];
  audio.onState((state) => states.push(state.status));
  audio.listen(() => {});
  await expect.poll(() => audio.getState().status).toBe('unavailable');
  expect(audio.getState().detail).toContain('USB Audio Device');
  expect(states).toEqual(['unavailable']);
});

test('microphone audio is played into the radio only when that is allowed', async () => {
  const muted = countingDevice();
  audio = new Audio(muted.spy, false);
  audio.talk(new Uint8Array(640));
  await new Promise((resolve) => setTimeout(resolve, 50));
  audio.talk(new Uint8Array(640));
  expect(muted.device.written).toBe(0);
  audio.stop();

  const open = countingDevice();
  audio = new Audio(open.spy, true);
  expect(audio.getState().canTalk).toBe(true);
  // The first samples open the output; the next ones are played.
  audio.talk(new Uint8Array(640));
  await new Promise((resolve) => setTimeout(resolve, 50));
  audio.talk(new Uint8Array(640));
  expect(open.device.written).toBe(320);
});
