import { afterEach, expect, test } from 'vitest';
import { AUTO_BAUD, SIM_PORT } from '../../config.ts';
import { Radio } from '../radio.ts';
import { CwSender, chunk } from './sender.ts';

const SIM = { port: SIM_PORT, baudRate: AUTO_BAUD, stopBits: 2 } as const;
let current: Radio | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

/** A simulated radio, read once, in CW at a brisk speed, break-in off as it comes. */
async function cwRadio(txEnabled = true): Promise<Radio> {
  const radio = new Radio(SIM, { txEnabled });
  current = radio;
  radio.start();
  await expect.poll(() => radio.getState().sMeter, { timeout: 5000 }).not.toBeNull();
  await radio.set('modeMain', 'CW-U');
  await radio.set('keySpeed', 60);
  await expect.poll(() => radio.getState().keySpeed).toBe(60);
  return radio;
}

test('text is cut into pieces a memory holds, at spaces', () => {
  expect(chunk('CQ CQ DE K1ABC K')).toEqual(['CQ CQ DE K1ABC K']);
  const long = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AGAIN AND AGAIN AND AGAIN';
  const pieces = chunk(long);
  expect(pieces.join(' ')).toBe(long);
  expect(pieces.every((piece) => piece.length <= 50)).toBe(true);
  expect(pieces.length).toBe(2);
  expect(chunk('A'.repeat(120)).map((piece) => piece.length)).toEqual([50, 50, 20]);
});

test('typed Morse goes out through the scratch memory, which gets its own text back', async () => {
  const radio = await cwRadio();
  const sender = new CwSender(radio, 5);
  const states: (string | null)[] = [];
  sender.onState((sending) => states.push(sending && `${sending.sent}/${sending.text.length}`));
  expect((await radio.listMessages())[4]).toBe('R 5NN K');

  let keyed = false;
  const unwatch = radio.onState((state) => {
    if (state.mox && state.transmitting) keyed = true;
  });
  // Typed in lower case with a double space: sent as "CQ TEST DE K1ABC K", 18 characters.
  await sender.send('cq test de k1abc  k');
  unwatch();
  // The transmitter was keyed with MOX, break-in being off, and let go of after.
  expect(keyed).toBe(true);
  await expect.poll(() => radio.getState().mox).toBe(false);
  expect(sender.getState()).toBeNull();
  expect(states[0]).toBe('0/18');
  expect(states[states.length - 1]).toBeNull();
  expect(states).toContain('18/18');
  // The memory holds the owner's text again, and the radio is no longer transmitting.
  expect((await radio.listMessages())[4]).toBe('R 5NN K');
  await expect.poll(() => radio.getState().transmitting).toBe(false);
}, 20_000);

test('in practice the keyer sounds the text without the transmitter', async () => {
  const radio = await cwRadio();
  const sender = new CwSender(radio, 5);
  let transmitted = false;
  const unwatch = radio.onState((state) => {
    if (state.transmitting) transmitted = true;
  });
  await sender.send('TEST', true);
  unwatch();
  expect(transmitted).toBe(false);
  await expect.poll(() => radio.getState().mox).toBe(false);
}, 20_000);

test('sending is refused outside the CW modes, while sending, and with transmit off', async () => {
  const radio = await cwRadio();
  const sender = new CwSender(radio, 5);
  await radio.set('modeMain', 'USB');
  await expect.poll(() => radio.getState().modeMain).toBe('USB');
  await expect(sender.send('TEST')).rejects.toThrow('CW mode');

  await radio.set('modeMain', 'CW-U');
  await expect.poll(() => radio.getState().modeMain).toBe('CW-U');
  const first = sender.send('TEST TEST TEST');
  await expect.poll(() => sender.getState()).not.toBeNull();
  await expect(sender.send('AGAIN')).rejects.toThrow('already');
  await sender.stop();
  await first;
  expect(sender.getState()).toBeNull();

  await radio.stop();
  const quiet = await cwRadio(false);
  await expect(new CwSender(quiet, 5).send('TEST')).rejects.toThrow();
}, 20_000);
