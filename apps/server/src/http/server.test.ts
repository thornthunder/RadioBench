import {
  RX_AUDIO_KIND,
  TX_AUDIO_KIND,
  decodeAudio,
  encodeAudio,
  type DecodeBatch,
  type DecoderState,
  type MemoryChannel,
  type RadioState,
  type ServerMessage,
} from '@radiobench/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { AUTO_BAUD, SIM_PORT } from '../config.ts';
import { Audio, SimulatedAudioDevice } from '../radio/audio/audio.ts';
import { Decoder, type DecodeEngine } from '../radio/digi/decoder.ts';
import { Radio } from '../radio/radio.ts';
import { Scope } from '../radio/scope/scope.ts';
import { createHttpServer } from './server.ts';

let radio: Radio;
let audio: Audio;
let sound: SimulatedAudioDevice;
let decoder: Decoder;
let app: FastifyInstance;

/** An engine that decodes nothing; slots here are never heard from their start anyway. */
class TestEngine implements DecodeEngine {
  readonly depth = 1;
  readonly threads = 1;
  async decode(): Promise<[]> {
    return [];
  }
  close(): void {}
}

afterEach(async () => {
  decoder.stop();
  audio.stop();
  await radio.stop();
  await app.close();
});

/** A running server on a free port, with a simulated radio that has been read once. */
async function serve(txEnabled: boolean): Promise<string> {
  radio = new Radio({ port: SIM_PORT, baudRate: AUTO_BAUD, stopBits: 2 }, { txEnabled });
  sound = new SimulatedAudioDevice();
  audio = new Audio(sound, txEnabled);
  decoder = new Decoder(audio, new TestEngine(), {
    dial: () => ({ hz: 14_074_000, mode: 'DATA-U' }),
  });
  app = await createHttpServer(radio, new Scope(null), audio, decoder, 'no-web-client-here');
  await app.listen({ host: '127.0.0.1', port: 0 });
  radio.start();
  await expect.poll(() => radio.getState().sMeter, { timeout: 5000 }).not.toBeNull();
  const address = app.server.address();
  return typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
}

/** A connected client that keeps what it is sent as the web page does. */
async function client(host: string) {
  const socket = new WebSocket(`ws://${host}/ws`);
  socket.binaryType = 'arraybuffer';
  const seen = {
    state: null as RadioState | null,
    errors: [] as string[],
    menu: {} as Record<string, string>,
    memories: null as MemoryChannel[] | null,
    messages: null as string[] | null,
    audioSamples: 0,
    decoder: null as DecoderState | null,
    batches: [] as DecodeBatch[],
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      seen.audioSamples += (decodeAudio(RX_AUDIO_KIND, event.data as ArrayBuffer)?.length ?? 0) / 2;
      return;
    }
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === 'state') seen.state = message.state;
    else if (message.type === 'patch' && seen.state) {
      seen.state = { ...seen.state, ...message.patch };
    } else if (message.type === 'error') seen.errors.push(message.message);
    else if (message.type === 'menu') Object.assign(seen.menu, message.values);
    else if (message.type === 'memories') seen.memories = message.channels;
    else if (message.type === 'messages') seen.messages = message.texts;
    else if (message.type === 'decoder') seen.decoder = message.decoder;
    else if (message.type === 'decodes') seen.batches.push(...message.batches);
  };
  await new Promise((resolve) => (socket.onopen = resolve));
  await expect.poll(() => seen.state).not.toBeNull();
  return { socket, seen, send: (message: object) => socket.send(JSON.stringify(message)) };
}

test('a client gets the whole state, then what changes, and its commands reach the radio', async () => {
  const host = await serve(false);
  const { seen, send } = await client(host);
  expect(seen.state).toMatchObject({ link: 'connected', frequencyA: 14_074_000 });

  send({ type: 'set', key: 'frequencyA', value: 7_074_000 });
  send({ type: 'action', action: 'swapVfo' });
  await expect.poll(() => seen.state?.frequencyA).toBe(7_074_000);
  await expect.poll(() => seen.state?.mainVfo).toBe('B');

  send({ type: 'set', key: 'frequencyA', value: 999_000_000 });
  send({ type: 'set', key: 'mox', value: true });
  await expect.poll(() => seen.errors).toHaveLength(2);
  expect(seen.errors[0]).toBe('Unrecognised command');
  expect(seen.errors[1]).toContain('switched off');
  expect(radio.getState().mox).toBe(false);
});

test('MOX is released when the client that switched it on goes away', async () => {
  const host = await serve(true);
  const keyer = await client(host);
  const watcher = await client(host);

  keyer.send({ type: 'set', key: 'mox', value: true });
  await expect.poll(() => watcher.seen.state?.transmitting).toBe(true);

  // Another client leaving changes nothing.
  const bystander = await client(host);
  bystander.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(radio.getState().mox).toBe(true);

  keyer.socket.close();
  await expect.poll(() => watcher.seen.state?.mox).toBe(false);
  await expect.poll(() => watcher.seen.state?.transmitting).toBe(false);
});

test('menus, memories and messages are read on request and follow what is changed', async () => {
  const host = await serve(false);
  const { seen, send } = await client(host);

  send({ type: 'menuRead', ids: ['030501', '030503'] });
  await expect.poll(() => seen.menu).toEqual({ '030501': '1', '030503': '2' });
  send({ type: 'menuSet', id: '030503', value: 3 });
  await expect.poll(() => seen.menu['030503']).toBe('3');
  // The state follows too, where it is built on a menu item.
  await expect.poll(() => seen.state?.channelStepHz, { timeout: 5000 }).toBe(10_000);

  send({ type: 'memoryList' });
  await expect
    .poll(() => seen.memories)
    .toEqual([{ channel: '001', frequencyHz: 7_000_000, mode: 'LSB', tag: '' }]);
  send({ type: 'memoryStore', channel: '012' });
  await expect.poll(() => seen.memories?.length).toBe(2);
  send({ type: 'memoryTag', channel: '012', tag: 'FT8 20M' });
  await expect
    .poll(() => seen.memories?.[1])
    .toEqual({ channel: '012', frequencyHz: 14_074_000, mode: 'DATA-U', tag: 'FT8 20M' });

  send({ type: 'messageList' });
  await expect.poll(() => seen.messages).toEqual(['', '', '', 'DE FT-710 K', 'R 5NN K']);
  send({ type: 'messageStore', number: 1, text: 'CQ TEST' });
  await expect.poll(() => seen.messages?.[0]).toBe('CQ TEST');

  // Sending a message transmits, which this server does not allow.
  send({ type: 'messagePlay', number: 1 });
  await expect.poll(() => seen.errors.at(-1)).toContain('switched off');
});

test('received audio goes only to clients that ask for it, and only while they do', async () => {
  const host = await serve(false);
  const listener = await client(host);
  const other = await client(host);

  listener.send({ type: 'listen', on: true });
  await expect.poll(() => listener.seen.audioSamples, { timeout: 3000 }).toBeGreaterThan(4000);
  expect(other.seen.audioSamples).toBe(0);

  listener.send({ type: 'listen', on: false });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const heard = listener.seen.audioSamples;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(listener.seen.audioSamples).toBe(heard);
});

test('the decoder runs while a client wants decodes, in the mode the last one chose', async () => {
  const host = await serve(false);
  const watcher = await client(host);
  const other = await client(host);
  expect(watcher.seen.decoder).toMatchObject({ status: 'idle', mode: 'FT8' });

  watcher.send({ type: 'decode', on: true, mode: 'FT4' });
  await expect.poll(() => watcher.seen.decoder?.status).toBe('running');
  expect(watcher.seen.decoder?.mode).toBe('FT4');
  // Everyone learns of the state; the empty list of past decodes goes to the one who asked.
  expect(other.seen.decoder?.mode).toBe('FT4');
  expect(watcher.seen.batches).toEqual([]);

  watcher.send({ type: 'decode', on: false });
  await expect.poll(() => watcher.seen.decoder?.status).toBe('idle');
});

test('microphone audio reaches the radio only where transmitting is allowed', async () => {
  const microphone = encodeAudio(TX_AUDIO_KIND, new Uint8Array(640));

  const refusing = await client(await serve(false));
  refusing.socket.send(microphone);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(sound.written).toBe(0);
  audio.stop();
  await radio.stop();
  await app.close();

  const allowing = await client(await serve(true));
  // The first frames open the output device; what follows is played.
  for (let i = 0; i < 5; i++) {
    allowing.socket.send(microphone);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(sound.written).toBeGreaterThan(0);
});
