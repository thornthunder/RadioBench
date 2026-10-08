import { afterEach, describe, expect, test } from 'vitest';
import { AUTO_BAUD, SIM_PORT, type CatConfig } from '../config.ts';
import { SimulatedTransport } from './cat/simulator.ts';
import type { CatTransport } from './cat/transport.ts';
import { Radio, baudRatesToTry } from './radio.ts';

const SIM: CatConfig = { port: SIM_PORT, baudRate: AUTO_BAUD, stopBits: 2 };

let radio: Radio;

afterEach(() => radio?.stop());

/** A simulated radio that records what is sent to it and can be made to refuse commands. */
function recordingSimulator(refuse: string[] = []) {
  const sent: string[] = [];
  const createTransport = () => {
    const transport = new SimulatedTransport();
    const write = transport.write.bind(transport);
    let refused: (() => void) | null = null;
    const open = transport.open.bind(transport);
    transport.open = async (handlers) => {
      refused = () => handlers.onData('?;');
      await open(handlers);
    };
    transport.write = async (data) => {
      sent.push(data);
      if (refuse.includes(data)) refused?.();
      else await write(data);
    };
    return transport;
  };
  return { sent, createTransport };
}

/** Starts a radio and waits until it has read everything once. */
async function started(options: ConstructorParameters<typeof Radio>[1] = {}): Promise<Radio> {
  radio = new Radio(SIM, options);
  radio.start();
  await expect.poll(() => radio.getState().sMeter, { timeout: 5000 }).not.toBeNull();
  return radio;
}

test('connects to the simulator and reads the whole front panel', async () => {
  const state = (await started()).getState();
  expect(state).toMatchObject({
    link: 'connected',
    linkError: null,
    port: SIM_PORT,
    txEnabled: false,
    frequencyA: 14_074_000,
    frequencyB: 3_573_800,
    mainVfo: 'A',
    modeMain: 'DATA-U',
    modeSub: 'LSB',
    agc: 'auto-mid',
    preamp: 'AMP1',
    afGain: 38,
    width: 19,
    power: 100,
    tuner: true,
    scopeSpan: 6,
    scopeMode: 4,
    funcKnob: 'RF POWER',
    vfoState: 'vfo',
    transmitting: false,
    dialStepSsbCwHz: 10,
    channelStepHz: 5000,
    firmware: '01-12',
  });
  // Nothing the radio was asked for is left unknown.
  const unknown = Object.entries(state).filter(
    ([key, value]) => value === null && key !== 'linkError',
  );
  expect(unknown.map(([key]) => key).filter((key) => !key.startsWith('meter'))).toEqual([]);
});

test('settings reach the radio, and the state follows what the radio then reports', async () => {
  await started();
  await radio.set('frequencyA', 7_074_000);
  await radio.set('modeMain', 'LSB');
  await radio.set('noiseBlanker', true);
  await radio.set('ifShiftHz', -400);
  await radio.set('agc', 'auto');
  expect(radio.getState()).toMatchObject({
    frequencyA: 7_074_000,
    modeMain: 'LSB',
    noiseBlanker: true,
    ifShiftHz: -400,
  });
  // Asked for automatic AGC, the radio says which time constant it picked.
  await expect.poll(() => radio.getState().agc).toBe('auto-mid');
});

test('of settings sent faster than the radio takes them, only the latest is sent', async () => {
  const { sent, createTransport } = recordingSimulator();
  await started({ createTransport });
  const requests = Array.from({ length: 30 }, (_, level) => radio.set('afGain', level));
  await Promise.all(requests);
  expect(radio.getState().afGain).toBe(29);
  expect(sent.filter((data) => /^AG0\d{3};$/.test(data)).length).toBeLessThanOrEqual(2);
  expect(sent).toContain('AG0029;');
});

test('actions are carried out and everything is read afresh', async () => {
  await started();
  await radio.act('bandSelect', 3);
  await expect.poll(() => radio.getState().frequencyA).toBe(7_074_000);
  await radio.act('swapVfo');
  await expect.poll(() => radio.getState().mainVfo).toBe('B');
  expect(radio.getState().modeMain).toBe('LSB');
});

test('says so when the radio refuses a command, and carries on', async () => {
  const { createTransport } = recordingSimulator(['NB01;']);
  await started({ createTransport });
  await expect(radio.set('noiseBlanker', true)).rejects.toThrow('did not accept');
  expect(radio.getState().noiseBlanker).toBe(false);
  await expect(radio.act('bandSelect', 12)).rejects.toThrow('no such band');
  await radio.set('noiseReduction', true);
  expect(radio.getState()).toMatchObject({ link: 'connected', noiseReduction: true });
});

describe('transmitting', () => {
  test('is refused unless the server allows it', async () => {
    const { sent, createTransport } = recordingSimulator();
    await started({ createTransport });
    await expect(radio.set('mox', true)).rejects.toThrow('switched off');
    await expect(radio.set('vox', true)).rejects.toThrow('switched off');
    await expect(radio.act('tuneStart')).rejects.toThrow('switched off');
    expect(sent.filter((data) => /^(MX1|VX1|AC003|TX1);$/.test(data))).toEqual([]);
    // Switching things off is always allowed.
    await radio.set('mox', false);
  });

  test('MOX keys the radio when allowed, and is released when the server stops', async () => {
    const { sent, createTransport } = recordingSimulator();
    await started({ createTransport, txEnabled: true });
    await radio.set('mox', true);
    await expect.poll(() => radio.getState().transmitting).toBe(true);
    await expect.poll(() => radio.getState().meterPo).toBeGreaterThan(0);
    await radio.stop();
    expect(sent.at(-1)).toBe('MX0;');
  });

  test('MOX is released after its time limit', async () => {
    await started({ txEnabled: true, maxMoxMs: 150 });
    await radio.set('mox', true);
    expect(radio.getState().mox).toBe(true);
    await expect.poll(() => radio.getState().mox, { timeout: 2000 }).toBe(false);
    await expect.poll(() => radio.getState().transmitting).toBe(false);
  });
});

test('memory channels can be listed, stored, named and recalled', async () => {
  await started();
  expect(await radio.listMemories()).toEqual([
    { channel: '001', frequencyHz: 7_000_000, mode: 'LSB', tag: '' },
  ]);

  await radio.set('frequencyA', 14_200_000);
  await radio.set('modeMain', 'USB');
  expect(await radio.storeMemory('020')).toEqual({
    channel: '020',
    frequencyHz: 14_200_000,
    mode: 'USB',
    tag: '',
  });
  expect((await radio.tagMemory('020', 'DX WINDOW'))?.tag).toBe('DX WINDOW');
  expect((await radio.listMemories()).map((memory) => memory.channel)).toEqual(['001', '020']);
  // An empty channel cannot be named.
  await expect(radio.tagMemory('050', 'NOTHING')).rejects.toThrow('did not accept');

  await radio.recallMemory('020');
  await expect.poll(() => radio.getState().vfoState).toBe('memory');
  expect(radio.getState().memoryChannel).toBe('020');
  // Recalling another channel stays on the memories rather than flipping back to the VFO.
  await radio.recallMemory('001');
  await expect.poll(() => radio.getState().memoryChannel).toBe('001');
  expect(radio.getState().vfoState).toBe('memory');
});

test('CW text memories can be read and written', async () => {
  await started();
  expect(await radio.listMessages()).toEqual(['', '', '', 'DE FT-710 K', 'R 5NN K']);
  await radio.storeMessage(2, 'CQ CQ DE ZR1JT');
  expect((await radio.listMessages())[1]).toBe('CQ CQ DE ZR1JT');
  await expect(radio.playMessage(2)).rejects.toThrow('switched off');
  await expect(radio.playVoice(1)).rejects.toThrow('switched off');
  // Stopping is always allowed.
  await radio.playMessage(0);
  await radio.playVoice(0);
});

test('menu values are reported as they are read and after they are set', async () => {
  await started();
  const reported: Record<string, string> = {};
  radio.onMenu((id, raw) => (reported[id] = raw));
  await radio.readMenu(['010101', '030503', '040101']);
  expect(Object.keys(reported).sort()).toEqual(['010101', '030503', '040101']);
  await radio.setMenu('030503', '0');
  expect(reported['030503']).toBe('0');
  await expect.poll(() => radio.getState().channelStepHz, { timeout: 5000 }).toBe(1000);
  // A value of the wrong shape is refused, and the radio's own value is read back.
  await expect(radio.setMenu('030503', '77')).rejects.toThrow('did not accept');
  expect(reported['030503']).toBe('0');
});

test('the radio can be switched off, and on again', async () => {
  const { sent, createTransport } = recordingSimulator();
  // One simulated radio for the whole test: it has to stay off between connections.
  const transport = createTransport();
  radio = new Radio(SIM, { createTransport: () => transport });
  radio.start();
  await expect.poll(() => radio.getState().sMeter, { timeout: 5000 }).not.toBeNull();

  await radio.power(false);
  await expect.poll(() => radio.getState().link, { timeout: 8000 }).toBe('disconnected');
  expect(sent).toContain('PS0;');

  await radio.power(true);
  await expect.poll(() => radio.getState().link, { timeout: 20_000 }).toBe('connected');
  expect(sent.filter((data) => data === 'PS1;')).toHaveLength(2);
}, 30_000);

test('listeners are told when the link goes down', async () => {
  await started();
  const links: string[] = [];
  radio.onState((state) => links.push(state.link));
  await radio.stop();
  expect(links.at(-1)).toBe('disconnected');
  expect(radio.getState().frequencyA).toBeNull();
});

test('reconnects after the link drops', async () => {
  let drop = () => {};
  radio = new Radio(
    { port: 'COM9', baudRate: 9600, stopBits: 2 },
    {
      createTransport: () => {
        const transport = new SimulatedTransport();
        const open = transport.open.bind(transport);
        transport.open = async (handlers) => {
          drop = () => handlers.onClose(new Error('cable pulled'));
          await open(handlers);
        };
        return transport;
      },
    },
  );
  radio.start();
  await expect.poll(() => radio.getState().link).toBe('connected');
  const pending = radio.set('afGain', 10).catch((error: Error) => error.message);

  drop();
  await expect.poll(() => radio.getState().linkError).toBe('cable pulled');
  expect(radio.getState()).toMatchObject({ link: 'disconnected', frequencyA: null });
  // A command caught by the drop either went out just before it or is reported as failed.
  expect([undefined, 'The radio is not connected']).toContain(await pending);

  await expect.poll(() => radio.getState().link, { timeout: 5000 }).toBe('connected');
}, 10_000);

test('commands fail while the radio is not connected', async () => {
  radio = new Radio(SIM);
  await expect(radio.set('frequencyA', 7_074_000)).rejects.toThrow('not connected');
  await expect(radio.act('swapVfo')).rejects.toThrow('not connected');
});

describe('baud rate', () => {
  /** A port that opens fine but has nothing listening at this speed. */
  const deaf: CatTransport = {
    open: async () => {},
    write: async () => {},
    close: async () => {},
  };

  test('auto tries each rate until the radio answers', async () => {
    const tried: number[] = [];
    radio = new Radio(
      { port: 'COM9', baudRate: AUTO_BAUD, stopBits: 2 },
      {
        createTransport: (_path, baudRate) => {
          tried.push(baudRate);
          return baudRate === 9600 ? new SimulatedTransport() : deaf;
        },
      },
    );
    radio.start();
    await expect.poll(() => radio.getState().link, { timeout: 3000 }).toBe('connected');
    expect(tried).toEqual([38400, 9600]);
  });

  test('a fixed rate is the only one tried, and the failure names it', async () => {
    const tried: number[] = [];
    radio = new Radio(
      { port: 'COM9', baudRate: 4800, stopBits: 2 },
      {
        createTransport: (_path, baudRate) => {
          tried.push(baudRate);
          return deaf;
        },
      },
    );
    radio.start();
    await expect
      .poll(() => radio.getState().linkError, { timeout: 3000 })
      .toBe('No answer from the radio on COM9 at 4800 baud. Is it switched on?');
    expect(tried).toEqual([4800]);
  });

  test('the rate that worked last time is tried first', () => {
    expect(baudRatesToTry(AUTO_BAUD, null)).toEqual([38400, 9600, 19200, 4800, 115200]);
    expect(baudRatesToTry(AUTO_BAUD, 9600)).toEqual([9600, 38400, 19200, 4800, 115200]);
    expect(baudRatesToTry(19200, 9600)).toEqual([19200]);
  });
});
