import { describe, expect, test } from 'vitest';
import {
  AUDIO_SPECTRUM_BINS,
  AUDIO_WAVE_COLUMNS,
  MODES,
  RX_AUDIO_KIND,
  SCOPE_BINS,
  TX_AUDIO_KIND,
  decodeAudio,
  decodeScopeFrame,
  delayMs,
  describeScopeMode,
  encodeAudio,
  encodeScopeFrame,
  isValidSetting,
  parseClientMessage,
  scopeModeNumber,
  stepSetting,
  widthHz,
} from './index.ts';

describe('scope frames', () => {
  const frame = {
    startHz: 3_323_000,
    spanHz: 500_000,
    sMeter: 112,
    bins: Uint8Array.from({ length: SCOPE_BINS }, (_, i) => i % 256),
    audioSpectrum: Uint8Array.from({ length: AUDIO_SPECTRUM_BINS }, (_, i) => 255 - i),
    audioWave: Uint8Array.from({ length: AUDIO_WAVE_COLUMNS * 2 }, (_, i) => (i * 7) % 256),
  };

  test('survive encoding and decoding', () => {
    expect(decodeScopeFrame(encodeScopeFrame(frame).buffer as ArrayBuffer)).toEqual(frame);
  });

  test('keep a start below zero, as a wide sweep near the bottom of the range has', () => {
    const packet = encodeScopeFrame({ ...frame, startHz: -470_000, spanHz: 1_000_000 });
    expect(decodeScopeFrame(packet.buffer as ArrayBuffer)?.startHz).toBe(-470_000);
  });

  test('anything else is not a scope frame', () => {
    expect(decodeScopeFrame(new ArrayBuffer(16))).toBeNull();
    expect(decodeScopeFrame(new ArrayBuffer(encodeScopeFrame(frame).length))).toBeNull();
    expect(
      decodeScopeFrame(encodeAudio(RX_AUDIO_KIND, new Uint8Array(64)).buffer as ArrayBuffer),
    ).toBeNull();
  });
});

describe('audio frames', () => {
  test('carry samples in either direction, told apart by their kind', () => {
    const samples = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const received = encodeAudio(RX_AUDIO_KIND, samples);
    expect(decodeAudio(RX_AUDIO_KIND, received)).toEqual(samples);
    expect(decodeAudio(TX_AUDIO_KIND, received)).toBeNull();
    expect(decodeAudio(RX_AUDIO_KIND, Uint8Array.from([1, 0, 0, 0]))).toBeNull();
  });

  test('half a sample at the end is left off', () => {
    const packet = encodeAudio(TX_AUDIO_KIND, Uint8Array.from([1, 2, 3]));
    expect(decodeAudio(TX_AUDIO_KIND, packet)).toEqual(Uint8Array.from([1, 2]));
  });
});

describe('the other commands a client can send', () => {
  test('are accepted when well formed', () => {
    const accepted = [
      { type: 'listen', on: true },
      { type: 'power', on: false },
      { type: 'record', on: true },
      { type: 'menuRead', ids: ['030103', '010101'] },
      { type: 'menuSet', id: '030503', value: 2 },
      { type: 'memoryList' },
      { type: 'memoryRecall', channel: '001' },
      { type: 'memoryStore', channel: '099' },
      { type: 'memoryTag', channel: '010', tag: 'FT8 40M' },
      { type: 'messageList' },
      { type: 'messageStore', number: 4, text: 'CQ CQ DE ZR1JT K' },
      { type: 'messagePlay', number: 0 },
      { type: 'voicePlay', number: 5 },
    ];
    for (const message of accepted) {
      expect(parseClientMessage(JSON.stringify(message)), message.type).toEqual(message);
    }
  });

  test.each([
    ['a menu item that does not exist', { type: 'menuRead', ids: ['999999'] }],
    ['a menu value out of range', { type: 'menuSet', id: '030503', value: 9 }],
    ['channel 000', { type: 'memoryRecall', channel: '000' }],
    ['channel 100', { type: 'memoryStore', channel: '100' }],
    ['a name that is too long', { type: 'memoryTag', channel: '001', tag: 'THIRTEEN CHAR' }],
    ['a name that would end the command', { type: 'memoryTag', channel: '001', tag: 'A;B' }],
    ['lower case in a CW message', { type: 'messageStore', number: 1, text: 'cq' }],
    ['a brace in a CW message', { type: 'messageStore', number: 1, text: 'CQ}' }],
    ['CW message 6', { type: 'messagePlay', number: 6 }],
    ['a switch that is not on or off', { type: 'power', on: 'yes' }],
  ])('rejects %s', (_name, message) => {
    expect(parseClientMessage(JSON.stringify(message))).toBeNull();
  });
});

describe('settings', () => {
  test('accept values within their range and on their step', () => {
    expect(isValidSetting('frequencyA', 14_074_000)).toBe(true);
    expect(isValidSetting('modeMain', 'DATA-U')).toBe(true);
    expect(isValidSetting('noiseBlanker', false)).toBe(true);
    expect(isValidSetting('scopeLevel', -15.5)).toBe(true);
    expect(isValidSetting('ifShiftHz', -1200)).toBe(true);
  });

  test('reject everything else', () => {
    expect(isValidSetting('frequencyA', 144_000_000)).toBe(false);
    expect(isValidSetting('frequencyA', '14074000')).toBe(false);
    expect(isValidSetting('modeMain', 'C4FM')).toBe(false);
    expect(isValidSetting('noiseBlanker', 1)).toBe(false);
    expect(isValidSetting('scopeLevel', -15.3)).toBe(false);
    expect(isValidSetting('ifShiftHz', 30)).toBe(false);
  });

  test('step by knob clicks and stop at the ends of the range', () => {
    expect(stepSetting('ifShiftHz', 0, 3)).toBe(60);
    expect(stepSetting('scopeLevel', -15, -1)).toBe(-15.5);
    expect(stepSetting('afGain', 250, 10)).toBe(255);
    expect(stepSetting('power', 6, -5)).toBe(5);
  });

  test('every scope mode the radio uses survives being taken apart and put together', () => {
    for (const mode of [0, 1, 2, 3, 4, 6, 7, 9, 10]) {
      expect(scopeModeNumber(describeScopeMode(mode))).toBe(mode);
    }
    expect(describeScopeMode(4)).toEqual({
      view: 'waterfall',
      placement: 'CENTER',
      expanded: false,
    });
    expect(describeScopeMode(9)).toEqual({ view: 'waterfall', placement: 'FIX', expanded: true });
  });

  test('width and delay settings translate to what the radio shows', () => {
    expect(widthHz('USB', 20)).toBe(3000);
    expect(widthHz('DATA-U', 19)).toBe(3500);
    expect(widthHz('CW-U', 0)).toBe(500);
    expect(widthHz('FM', 0)).toBe(16000);
    expect(delayMs(0)).toBe(30);
    expect(delayMs(8)).toBe(500);
    expect(delayMs(33)).toBe(3000);
    expect(MODES).toHaveLength(15);
  });
});

describe('parseClientMessage', () => {
  test('accepts well-formed commands', () => {
    expect(parseClientMessage('{"type":"set","key":"frequencyA","value":14074000}')).toEqual({
      type: 'set',
      key: 'frequencyA',
      value: 14_074_000,
    });
    expect(parseClientMessage('{"type":"action","action":"bandSelect","value":5}')).toEqual({
      type: 'action',
      action: 'bandSelect',
      value: 5,
    });
    expect(parseClientMessage('{"type":"action","action":"swapVfo"}')).toEqual({
      type: 'action',
      action: 'swapVfo',
    });
  });

  test('drops fields that are not part of the command', () => {
    expect(parseClientMessage('{"type":"set","key":"lock","value":true,"extra":1}')).toEqual({
      type: 'set',
      key: 'lock',
      value: true,
    });
  });

  test.each([
    ['not JSON', 'FA014074000;'],
    ['not an object', '42'],
    ['unknown type', '{"type":"transmit"}'],
    ['unknown setting', '{"type":"set","key":"selfDestruct","value":true}'],
    ['a key inherited from Object', '{"type":"set","key":"toString","value":true}'],
    ['frequency out of range', '{"type":"set","key":"frequencyA","value":144000000}'],
    ['wrong type of value', '{"type":"set","key":"lock","value":"yes"}'],
    ['unknown mode', '{"type":"set","key":"modeMain","value":"C4FM"}'],
    ['unknown action', '{"type":"action","action":"powerOff"}'],
    ['fractional action value', '{"type":"action","action":"bandSelect","value":1.5}'],
  ])('rejects %s', (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
