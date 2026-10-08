import { expect, test } from 'vitest';
import { CatClient, SET_SETTLE_MS } from './client.ts';
import { CatError, CatTimeoutError } from './errors.ts';
import { SimulatedTransport } from './simulator.ts';
import type { CatTransport, TransportHandlers } from './transport.ts';

async function connect(
  transport: CatTransport,
  onMessage?: (message: string) => void,
): Promise<CatClient> {
  const client = new CatClient(transport, onMessage);
  await transport.open({
    onData: (chunk) => client.receive(chunk),
    onClose: (error) => client.close(error),
  });
  return client;
}

/** A radio that is switched off: accepts everything, answers nothing. */
class SilentTransport implements CatTransport {
  readonly writes: { data: string; at: number }[] = [];
  handlers: TransportHandlers | null = null;

  async open(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
  }
  async write(data: string): Promise<void> {
    this.writes.push({ data, at: performance.now() });
  }
  async close(): Promise<void> {}
}

test('a query returns the reply without its terminator', async () => {
  const client = await connect(new SimulatedTransport());
  expect(await client.query('ID')).toBe('ID0800');
});

test('commands run in the order they were issued', async () => {
  const client = await connect(new SimulatedTransport());
  const results = await Promise.all([
    client.query('FA'),
    client.set('FA007074000'),
    client.query('FA'),
  ]);
  expect(results).toEqual(['FA014074000', undefined, 'FA007074000']);
});

test('a reply split across chunks is reassembled', async () => {
  const transport = new SilentTransport();
  const client = await connect(transport);
  const reply = client.query('FA');
  await expect.poll(() => transport.writes.length).toBe(1);
  transport.handlers?.onData('FA0140');
  transport.handlers?.onData('74000;');
  expect(await reply).toBe('FA014074000');
});

test('everything the radio says is passed on, asked for or not', async () => {
  const transport = new SilentTransport();
  const heard: string[] = [];
  const client = await connect(transport, (message) => heard.push(message));
  const reply = client.query('FA');
  await expect.poll(() => transport.writes.length).toBe(1);
  transport.handlers?.onData('MD02;FA014074000;');
  expect(await reply).toBe('FA014074000');
  transport.handlers?.onData('SM0100;');
  expect(heard).toEqual(['MD02', 'FA014074000', 'SM0100']);
});

test('a command the radio rejects fails, and the next one still works', async () => {
  const client = await connect(new SimulatedTransport());
  await expect(client.query('ZZ')).rejects.toThrow(CatError);
  await expect(client.set('FA999999999')).rejects.toThrow(CatError);
  expect(await client.query('ID')).toBe('ID0800');
});

test('a query the radio never answers times out', async () => {
  const client = await connect(new SilentTransport());
  await expect(client.query('ID')).rejects.toThrow(CatTimeoutError);
});

test('a set command is given time to be rejected before the next one goes out', async () => {
  const transport = new SilentTransport();
  const client = await connect(transport);
  await Promise.all([client.set('FA007074000'), client.set('MD02'), client.set('FA007100000')]);
  const [first, second, third] = transport.writes.map((write) => write.at);
  // Timers may fire a fraction of a millisecond early.
  expect(second! - first!).toBeGreaterThanOrEqual(SET_SETTLE_MS - 1);
  expect(third! - second!).toBeGreaterThanOrEqual(SET_SETTLE_MS - 1);
});

test('closing fails the command in flight and later ones', async () => {
  const client = await connect(new SilentTransport());
  const inFlight = client.query('FA');
  const gone = new Error('port closed');
  client.close(gone);
  await expect(inFlight).rejects.toBe(gone);
  await expect(client.query('FA')).rejects.toBe(gone);
});
