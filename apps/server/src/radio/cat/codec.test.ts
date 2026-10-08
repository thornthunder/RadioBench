import { isSettingKey, type RadioState, type SettingKey } from '@radiobench/protocol';
import { describe, expect, test } from 'vitest';
import { CatClient } from './client.ts';
import {
  FAST_READS,
  ONCE_READS,
  SLOW_READS,
  TX_READS,
  actionCommands,
  decode,
  keysTransmitter,
  memoryWriteCommand,
  messageCommand,
  parseIdReply,
  parseMemoryReply,
  parseMessageReply,
  parseTagReply,
  settingCommand,
  tagCommand,
} from './codec.ts';
import { CatError } from './errors.ts';
import { SimulatedTransport } from './simulator.ts';

/** What a real FT-710 (firmware 01-12) answered to RadioBench's read commands. */
const REAL_REPLIES = [
  'VS0',
  'FA014074000',
  'FB003573800',
  'MD0C',
  'MD11',
  'ST0',
  'FT0',
  'CF00000000',
  'CF001+0000',
  'FN0',
  'LK0',
  'AG0000',
  'RG0212',
  'SQ0000',
  'RA00',
  'PA00',
  'NB00',
  'NL0000',
  'NR00',
  'RL001',
  'BC00',
  'BP00000',
  'BP01150',
  'CO000000',
  'CO011500',
  'CO020000',
  'CO030025',
  'IS00+0000',
  'SH0019',
  'NA00',
  'PC100',
  'MG050',
  'PR01',
  'PR11',
  'PL050',
  'ML0000',
  'ML1000',
  'AO085',
  'VX0',
  'VG050',
  'VD08',
  'AV050',
  'AC001',
  'MX0',
  'TS0',
  'KR0',
  'KS020',
  'KP40',
  'SD04',
  'CS0',
  'MS50',
  'SS0010000',
  'SS0100000',
  'SS0210000',
  'SS0390000',
  'SS04-15.0',
  'SS0560000',
  'SS0640000',
  'DA00151520',
  'SF0D',
  'SF11',
  'CT00',
  'CN00012',
  'OS00',
  'AS1000',
  'AS2001',
];

describe('decoding what the radio says', () => {
  test('settings', () => {
    expect(decode('FA014074000')).toEqual({ frequencyA: 14_074_000 });
    expect(decode('MD0C')).toEqual({ modeMain: 'DATA-U' });
    expect(decode('MD11')).toEqual({ modeSub: 'LSB' });
    expect(decode('GT05')).toEqual({ agc: 'auto-mid' });
    expect(decode('CF00010000')).toEqual({ clar: 'rx' });
    expect(decode('CF00001000')).toEqual({ clar: 'tx' });
    expect(decode('CF001-0120')).toEqual({ clarOffsetHz: -120 });
    expect(decode('IS00-0400')).toEqual({ ifShiftHz: -400 });
    expect(decode('CO030030')).toEqual({ apfHz: 50 });
    expect(decode('BP01150')).toEqual({ manualNotchHz: 1500 });
    expect(decode('PR02')).toEqual({ processor: true });
    expect(decode('KP40')).toEqual({ keyPitchHz: 700 });
    expect(decode('SS04-15.0')).toEqual({ scopeLevel: -15 });
    expect(decode('SS0390000')).toEqual({ scopeColor: 10 });
    expect(decode('SS06A0000')).toEqual({ scopeMode: 10 });
    expect(decode('DA00151520')).toEqual({ contrast: 15, dimmer: 15, ledDimmer: 20 });
    expect(decode('SF0D')).toEqual({ funcKnob: 'RF POWER' });
    expect(decode('SF11')).toEqual({ dspKnob: 'SHIFT' });
    expect(decode('MS50')).toEqual({ txMeter: 'SWR' });
    expect(decode('AC003')).toEqual({ tuner: true });
  });

  test('readings and status', () => {
    expect(decode('SM0039')).toEqual({ sMeter: 39 });
    expect(decode('RM8210000')).toEqual({ meterVdd: 210 });
    expect(decode('RI00000000')).toEqual({
      hiSwr: false,
      recording: false,
      playing: false,
      transmitting: false,
      tuning: false,
      scanning: false,
      busy: false,
    });
    expect(decode('RI01010101')).toMatchObject({ hiSwr: true, transmitting: true, busy: true });
    expect(decode('RI00100000')).toMatchObject({ recording: true, playing: false });
    expect(decode('RI00200000')).toMatchObject({ recording: false, playing: true });
    // TX inhibited is not transmitting.
    expect(decode('RI00020000')).toMatchObject({ transmitting: false });
    expect(decode('IF000014074000+000000C00000')).toEqual({
      memoryChannel: '000',
      vfoState: 'vfo',
    });
    expect(decode('IF012007074000+000000210000')).toEqual({
      memoryChannel: '012',
      vfoState: 'memory',
    });
    expect(decode('VE00112')).toEqual({ firmware: '01-12' });
    expect(decode('EX0305012')).toEqual({ dialStepSsbCwHz: 20 });
    expect(decode('EX0305032')).toEqual({ channelStepHz: 5000 });
    expect(decode('EX0301020')).toEqual({ rfSqlKnob: 'RF' });
  });

  test('has no use for anything else', () => {
    expect(decode('ZZ123')).toBeNull();
    expect(decode('FA14074000')).toBeNull();
    expect(decode('MD0')).toBeNull();
    expect(decode('')).toBeNull();
  });

  test('the model ID', () => {
    expect(parseIdReply('ID0800')).toBe('0800');
    expect(() => parseIdReply('FA014074000')).toThrow(CatError);
  });
});

describe('encoding commands', () => {
  test('a set command is exactly what the radio itself reports for that value', () => {
    for (const reply of REAL_REPLIES) {
      const patch = decode(reply);
      expect(patch, reply).not.toBeNull();
      const state = { ...patch } as RadioState;
      for (const [key, value] of Object.entries(patch ?? {})) {
        expect(isSettingKey(key), `${reply} -> ${key}`).toBe(true);
        expect(settingCommand(key as SettingKey, value as never, state), key).toBe(reply);
      }
    }
  });

  test('values the survey did not happen to show', () => {
    const state = {} as RadioState;
    expect(settingCommand('modeMain', 'D-FM-N', state)).toBe('MD0F');
    expect(settingCommand('agc', 'auto', state)).toBe('GT04');
    expect(settingCommand('agc', 'auto-slow', state)).toBe('GT04');
    expect(settingCommand('agc', 'slow', state)).toBe('GT03');
    expect(settingCommand('clar', 'rxtx', state)).toBe('CF00011000');
    expect(settingCommand('clarOffsetHz', -9995, state)).toBe('CF001-9995');
    expect(settingCommand('apfHz', -250, state)).toBe('CO030000');
    expect(settingCommand('scopeLevel', 2.5, state)).toBe('SS04+02.5');
    expect(settingCommand('scopeColor', 11, state)).toBe('SS03A0000');
    expect(settingCommand('processor', true, state)).toBe('PR02');
    expect(settingCommand('attenuator', '18dB', state)).toBe('RA03');
    expect(settingCommand('funcKnob', 'BK-DELAY', state)).toBe('SF0H');
    expect(settingCommand('aessCutoff', '1000Hz', state)).toBe('AS2002');
  });

  test('a display setting cannot be sent before the other two are known', () => {
    expect(() => settingCommand('dimmer', 10, { contrast: null } as RadioState)).toThrow(
      'not been read',
    );
    const known = { contrast: 15, dimmer: 15, ledDimmer: 20 } as RadioState;
    expect(settingCommand('dimmer', 10, known)).toBe('DA00151020');
  });

  test('actions', () => {
    const onA = { mainVfo: 'A' } as RadioState;
    expect(actionCommands('bandSelect', 5, onA)).toEqual(['BS05']);
    expect(actionCommands('copyMainToSub', 0, onA)).toEqual(['AB']);
    expect(actionCommands('copyMainToSub', 0, { mainVfo: 'B' } as RadioState)).toEqual(['BA']);
    expect(actionCommands('tuneStart', 0, onA)).toEqual(['AC003']);
    expect(() => actionCommands('bandSelect', 12, onA)).toThrow('no such band');
  });

  test('memory channels, their names and CW messages, as the radio answered', () => {
    expect(parseMemoryReply('MR001007000000+000000100000')).toEqual({
      channel: '001',
      frequencyHz: 7_000_000,
      mode: 'LSB',
    });
    expect(parseMemoryReply('MREMG005167500+000000200000')).toMatchObject({
      channel: 'EMG',
      mode: 'USB',
    });
    expect(parseMemoryReply('MR001')).toBeNull();
    expect(parseTagReply('MT0010            ')).toBe('');
    expect(parseTagReply('MT0011FT8 40M     ')).toBe('FT8 40M');
    expect(parseMessageReply('KM4DE FT-710 K')).toBe('DE FT-710 K');
    expect(parseMessageReply('KM')).toBe('');

    // The radio took this for its channel 001, and refused it with a 0 after the mode.
    expect(memoryWriteCommand('001', 7_000_000, 'LSB')).toBe('MW001007000000+000000110000');
    expect(memoryWriteCommand('012', 14_074_000, 'DATA-U')).toBe('MW012014074000+000000C10000');
    expect(tagCommand('001', '')).toBe('MT0010            ');
    expect(tagCommand('012', 'FT8 20M')).toBe('MT0121FT8 20M     ');
    // A CW text goes without the closing brace the manual asks for: the radio would keep it.
    expect(messageCommand(4, 'DE FT-710 K')).toBe('KM4DE FT-710 K');
    expect(() => messageCommand(4, '')).toThrow('cannot be emptied');
  });

  test('setting the clock sends the date and the time in UTC', () => {
    const [date, time] = actionCommands('syncClock', 0, {} as RadioState);
    expect(date).toMatch(/^DT0\d{8}$/);
    expect(time).toMatch(/^DT1\d{6}$/);
  });

  test('knows which commands put the radio on the air', () => {
    expect(keysTransmitter('mox', true)).toBe(true);
    expect(keysTransmitter('vox', true)).toBe(true);
    expect(keysTransmitter('mox', false)).toBe(false);
    expect(keysTransmitter('tuner', true)).toBe(false);
  });
});

test('every read command is answered by the simulator with something the decoder takes', async () => {
  const transport = new SimulatedTransport();
  const client = new CatClient(transport);
  await transport.open({ onData: (chunk) => client.receive(chunk), onClose: () => {} });
  for (const read of [...ONCE_READS, ...FAST_READS, ...TX_READS, ...SLOW_READS]) {
    expect(decode(await client.query(read)), read).not.toBeNull();
  }
});
