import { encodeFT4, encodeFT8 } from '@e04/ft8ts';
import { AUDIO_SAMPLE_RATE, DIGI_SLOT_MS, type DigiMode } from '@radiobench/protocol';
import { afterAll, expect, test } from 'vitest';
import { Ft8tsEngine } from './engine.ts';

const engine = new Ft8tsEngine(2);
afterAll(() => engine.close());

/** A slot of band noise with the given transmissions in it, as the radio would deliver it. */
function slot(mode: DigiMode, signals: { text: string; hz: number; amplitude: number }[]) {
  const samples = new Float32Array((DIGI_SLOT_MS[mode] / 1000) * AUDIO_SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() - 0.5) * 0.02;
  const symbolRate = mode === 'FT8' ? 6.25 : 12000 / 576;
  for (const signal of signals) {
    const wave = (mode === 'FT8' ? encodeFT8 : encodeFT4)(signal.text, {
      sampleRate: AUDIO_SAMPLE_RATE,
      samplesPerSymbol: AUDIO_SAMPLE_RATE / symbolRate,
      baseFrequency: signal.hz,
    });
    const start = AUDIO_SAMPLE_RATE / 2;
    for (let i = 0; i < wave.length && start + i < samples.length; i++) {
      samples[start + i]! += signal.amplitude * wave[i]!;
    }
  }
  return samples;
}

test("FT8 is decoded in ft8ts's worker pool", async () => {
  const samples = slot('FT8', [
    { text: 'CQ K1ABC FN42', hz: 1200, amplitude: 0.1 },
    { text: 'K1ABC W9XYZ EN37', hz: 1850, amplitude: 0.02 },
  ]);
  const decodes = await engine.decode('FT8', samples, Date.now());
  const texts = decodes.map((decode) => decode.text).sort();
  expect(texts).toEqual(['CQ K1ABC FN42', 'K1ABC W9XYZ EN37']);
  const cq = decodes.find((decode) => decode.text.startsWith('CQ'))!;
  expect(cq.hz).toBe(1200);
  expect(Math.abs(cq.dt)).toBeLessThanOrEqual(0.1);
  expect(Number.isInteger(cq.snr)).toBe(true);
}, 20_000);

test('FT4 is decoded in a worker thread of its own', async () => {
  const samples = slot('FT4', [{ text: 'CQ W9XYZ EN37', hz: 2300, amplitude: 0.1 }]);
  const decodes = await engine.decode('FT4', samples, Date.now());
  expect(decodes.map((decode) => decode.text)).toEqual(['CQ W9XYZ EN37']);
  expect(decodes[0]!.hz).toBe(2300);
}, 20_000);
