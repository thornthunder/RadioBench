import {
  DSP_KNOB_FUNCTIONS,
  FUNC_KNOB_FUNCTIONS,
  MEMORY_TAG_LENGTH,
  SCOPE_SPEEDS,
  TX_METERS,
  type Action,
  type MemoryChannel,
  type Mode,
  type RadioState,
  type SettingKey,
  type SettingValue,
  type VfoState,
} from '@radiobench/protocol';
import { CatError, CommandError } from './errors.ts';

/**
 * The FT-710's CAT commands, after Yaesu's CAT Operation Reference Manual. Every read command
 * and reply format here has been checked against a real FT-710 (firmware 01-12); the set
 * commands follow the manual, which gives them the same format as the replies.
 */

/** What the FT-710 answers to "ID;". */
export const FT710_ID = '0800';

export type Patch = Partial<RadioState>;

const MODE_CODES: Record<Mode, string> = {
  LSB: '1',
  USB: '2',
  'CW-U': '3',
  FM: '4',
  AM: '5',
  'RTTY-L': '6',
  'CW-L': '7',
  'DATA-L': '8',
  'RTTY-U': '9',
  'DATA-FM': 'A',
  'FM-N': 'B',
  'DATA-U': 'C',
  'AM-N': 'D',
  PSK: 'E',
  'D-FM-N': 'F',
};
const MODES_BY_CODE = new Map(
  Object.entries(MODE_CODES).map(([mode, code]) => [code, mode as Mode]),
);

const AGC_REPORTED = ['off', 'fast', 'mid', 'slow', 'auto-fast', 'auto-mid', 'auto-slow'] as const;
const AGC_SET = ['off', 'fast', 'mid', 'slow', 'auto'];
const ATTENUATORS = ['OFF', '6dB', '12dB', '18dB'] as const;
const PREAMPS = ['IPO', 'AMP1', 'AMP2'] as const;
const CLAR = ['off', 'tx', 'rx', 'rxtx'] as const; // indexed by RX flag * 2 + TX flag
const FINE_TUNING = ['off', 'fine', 'fast'] as const;
const CTCSS = ['off', 'enc-dec', 'enc'] as const;
const REPEATER_SHIFTS = ['simplex', 'plus', 'minus'] as const;
const VFO_STATES: Record<string, VfoState> = {
  '0': 'vfo',
  '1': 'memory',
  '2': 'memory-tune',
  '3': 'qmb',
  '5': 'pms',
};
const DIAL_STEPS_HZ = [5, 10, 20];
const CHANNEL_STEPS_HZ = [1000, 2500, 5000, 10000];
/** Characters the radio uses to number more than ten choices: 0–9, then A, B, C... */
const DIGITS = '0123456789ABCDEFGHIJ';

type Rule = [pattern: RegExp, decode: (parts: string[]) => Patch];

const on = (flag: string | undefined) => flag === '1';
const int = (digits: string | undefined) => Number(digits);
const pick = <T>(list: readonly T[], digit: string | undefined): T | null =>
  list[DIGITS.indexOf(digit ?? '?')] ?? null;

const RULES: Rule[] = [
  [/^FA(\d{9})$/, ([hz]) => ({ frequencyA: int(hz) })],
  [/^FB(\d{9})$/, ([hz]) => ({ frequencyB: int(hz) })],
  [/^VS([01])$/, ([vfo]) => ({ mainVfo: vfo === '0' ? 'A' : 'B' })],
  [/^MD0(.)$/, ([code]) => ({ modeMain: MODES_BY_CODE.get(code ?? '') ?? null })],
  [/^MD1(.)$/, ([code]) => ({ modeSub: MODES_BY_CODE.get(code ?? '') ?? null })],
  [/^ST([01])$/, ([flag]) => ({ split: on(flag) })],
  [/^FT([01])$/, ([vfo]) => ({ txVfo: vfo === '0' ? 'main' : 'sub' })],
  [/^CF000([01])([01])000$/, ([rx, tx]) => ({ clar: CLAR[int(rx) * 2 + int(tx)] ?? null })],
  [/^CF001([+-]\d{4})$/, ([offset]) => ({ clarOffsetHz: int(offset) })],
  [/^FN([012])$/, ([state]) => ({ fineTuning: pick(FINE_TUNING, state) })],
  [/^LK([01])$/, ([flag]) => ({ lock: on(flag) })],

  [/^AG0(\d{3})$/, ([level]) => ({ afGain: int(level) })],
  [/^RG0(\d{3})$/, ([level]) => ({ rfGain: int(level) })],
  [/^SQ0(\d{3})$/, ([level]) => ({ squelch: int(level) })],
  [/^GT0([0-6])$/, ([agc]) => ({ agc: pick(AGC_REPORTED, agc) })],
  [/^RA0([0-3])$/, ([att]) => ({ attenuator: pick(ATTENUATORS, att) })],
  [/^PA0([0-2])$/, ([amp]) => ({ preamp: pick(PREAMPS, amp) })],
  [/^NB0([01])$/, ([flag]) => ({ noiseBlanker: on(flag) })],
  [/^NL0(\d{3})$/, ([level]) => ({ noiseBlankerLevel: int(level) })],
  [/^NR0([01])$/, ([flag]) => ({ noiseReduction: on(flag) })],
  [/^RL0(\d{2})$/, ([level]) => ({ noiseReductionLevel: int(level) })],
  [/^BC0([01])$/, ([flag]) => ({ autoNotch: on(flag) })],
  [/^BP00(\d{3})$/, ([state]) => ({ manualNotch: int(state) === 1 })],
  [/^BP01(\d{3})$/, ([tens]) => ({ manualNotchHz: int(tens) * 10 })],
  [/^CO00(\d{4})$/, ([state]) => ({ contour: int(state) === 1 })],
  [/^CO01(\d{4})$/, ([hz]) => ({ contourHz: int(hz) })],
  [/^CO02(\d{4})$/, ([state]) => ({ apf: int(state) === 1 })],
  // The APF frequency runs 0–50 for -250 to +250 Hz.
  [/^CO03(\d{4})$/, ([position]) => ({ apfHz: (int(position) - 25) * 10 })],
  [/^IS00([+-]\d{4})$/, ([hz]) => ({ ifShiftHz: int(hz) })],
  [/^SH00(\d{2})$/, ([width]) => ({ width: int(width) })],
  [/^NA0([01])$/, ([flag]) => ({ narrow: on(flag) })],

  [/^PC(\d{3})$/, ([watts]) => ({ power: int(watts) })],
  [/^MG(\d{3})$/, ([level]) => ({ micGain: int(level) })],
  // The processor commands use 1 for off and 2 for on.
  [/^PR0([12])$/, ([state]) => ({ processor: state === '2' })],
  [/^PR1([12])$/, ([state]) => ({ micEq: state === '2' })],
  [/^PL(\d{3})$/, ([level]) => ({ processorLevel: int(level) })],
  [/^ML0(\d{3})$/, ([state]) => ({ monitor: int(state) === 1 })],
  [/^ML1(\d{3})$/, ([level]) => ({ monitorLevel: int(level) })],
  [/^AO(\d{3})$/, ([level]) => ({ amcLevel: int(level) })],
  [/^VX([01])$/, ([flag]) => ({ vox: on(flag) })],
  [/^VG(\d{3})$/, ([level]) => ({ voxGain: int(level) })],
  [/^VD(\d{2})$/, ([delay]) => ({ voxDelay: int(delay) })],
  [/^AV(\d{3})$/, ([level]) => ({ antiVox: int(level) })],
  // The third digit is 0 with the tuner out of circuit, 1 with it in, 3 while it tunes.
  [/^AC0\d(\d)$/, ([state]) => ({ tuner: state !== '0' })],
  [/^MX([01])$/, ([flag]) => ({ mox: on(flag) })],
  [/^TS([01])$/, ([flag]) => ({ txw: on(flag) })],
  [/^MS([0-5])0$/, ([meter]) => ({ txMeter: pick(TX_METERS, meter) })],

  [/^KR([01])$/, ([flag]) => ({ keyer: on(flag) })],
  [/^KS(\d{3})$/, ([wpm]) => ({ keySpeed: int(wpm) })],
  [/^KP(\d{2})$/, ([step]) => ({ keyPitchHz: 300 + int(step) * 10 })],
  [/^BI([01])$/, ([flag]) => ({ breakIn: on(flag) })],
  [/^SD(\d{2})$/, ([delay]) => ({ breakInDelay: int(delay) })],
  [/^CS([01])$/, ([flag]) => ({ cwSpot: on(flag) })],

  [/^CT0([012])$/, ([state]) => ({ ctcss: pick(CTCSS, state) })],
  [/^CN00(\d{3})$/, ([tone]) => ({ ctcssTone: int(tone) })],
  [/^OS0([012])$/, ([shift]) => ({ repeaterShift: pick(REPEATER_SHIFTS, shift) })],

  [/^SS00([0-5])0000$/, ([speed]) => ({ scopeSpeed: pick(SCOPE_SPEEDS, speed) })],
  [/^SS01([0-4])0000$/, ([peak]) => ({ scopePeak: int(peak) + 1 })],
  [/^SS02([01])0000$/, ([flag]) => ({ scopeMarker: on(flag) })],
  [/^SS03([0-9A])0000$/, ([color]) => ({ scopeColor: DIGITS.indexOf(color ?? '?') + 1 })],
  [/^SS04([+-]\d\d\.\d)$/, ([level]) => ({ scopeLevel: Number(level) })],
  [/^SS05(\d)0000$/, ([span]) => ({ scopeSpan: int(span) })],
  [/^SS06([0-9A])0000$/, ([mode]) => ({ scopeMode: DIGITS.indexOf(mode ?? '?') })],
  [
    /^DA00(\d\d)(\d\d)(\d\d)$/,
    ([contrast, dimmer, led]) => ({
      contrast: int(contrast),
      dimmer: int(dimmer),
      ledDimmer: int(led),
    }),
  ],
  [/^SF0(.)$/, ([knob]) => ({ funcKnob: pick(FUNC_KNOB_FUNCTIONS, knob) })],
  [/^SF1(.)$/, ([knob]) => ({ dspKnob: pick(DSP_KNOB_FUNCTIONS, knob) })],
  [/^AS1(\d{3})$/, ([level]) => ({ aessLevel: int(level) })],
  [/^AS2(\d{3})$/, ([cutoff]) => ({ aessCutoff: int(cutoff) === 2 ? '1000Hz' : '700Hz' })],

  [/^SM0(\d{3})$/, ([level]) => ({ sMeter: int(level) })],
  [/^RM3(\d{3})\d{3}$/, ([level]) => ({ meterComp: int(level) })],
  [/^RM4(\d{3})\d{3}$/, ([level]) => ({ meterAlc: int(level) })],
  [/^RM5(\d{3})\d{3}$/, ([level]) => ({ meterPo: int(level) })],
  [/^RM6(\d{3})\d{3}$/, ([level]) => ({ meterSwr: int(level) })],
  [/^RM7(\d{3})\d{3}$/, ([level]) => ({ meterId: int(level) })],
  [/^RM8(\d{3})\d{3}$/, ([level]) => ({ meterVdd: int(level) })],
  [
    // HI-SWR, recorder, RX/TX/inhibited, unused, tuning, scan, squelch open.
    /^RI0(\d)(\d)(\d)\d(\d)(\d)(\d)$/,
    ([swr, recorder, tx, tuning, scan, busy]) => ({
      hiSwr: on(swr),
      recording: recorder === '1',
      playing: recorder === '2',
      transmitting: tx === '1',
      tuning: on(tuning),
      scanning: scan !== '0',
      busy: on(busy),
    }),
  ],
  [
    // Memory channel, frequency, clarifier (offset, RX, TX), mode, VFO or memory, and FM details.
    /^IF(.{3})\d{9}[+-]\d{4}[01][01].(\d)\d00\d$/,
    ([channel, state]) => ({
      memoryChannel: channel ?? null,
      vfoState: VFO_STATES[state ?? ''] ?? null,
    }),
  ],
  [/^VE0(\d\d)(\d\d)$/, ([major, minor]) => ({ firmware: `${major}-${minor}` })],

  // Menu items that shape how the knobs behave.
  [/^EX030102([01])$/, ([knob]) => ({ rfSqlKnob: knob === '0' ? 'RF' : 'SQL' })],
  [/^EX030501([0-2])$/, ([step]) => ({ dialStepSsbCwHz: DIAL_STEPS_HZ[int(step)] ?? null })],
  [/^EX030502([0-2])$/, ([step]) => ({ dialStepDataHz: DIAL_STEPS_HZ[int(step)] ?? null })],
  [/^EX030503([0-3])$/, ([step]) => ({ channelStepHz: CHANNEL_STEPS_HZ[int(step)] ?? null })],
];

const RULES_BY_COMMAND = new Map<string, Rule[]>();
for (const rule of RULES) {
  const command = rule[0].source.slice(1, 3);
  RULES_BY_COMMAND.set(command, [...(RULES_BY_COMMAND.get(command) ?? []), rule]);
}

/** What a message from the radio says about its state; null if RadioBench has no use for it. */
export function decode(message: string): Patch | null {
  for (const [pattern, toPatch] of RULES_BY_COMMAND.get(message.slice(0, 2)) ?? []) {
    const match = pattern.exec(message);
    if (match) return toPatch(match.slice(1));
  }
  return null;
}

export function parseIdReply(reply: string): string {
  const id = /^ID(\d{4})$/.exec(reply)?.[1];
  if (id === undefined) throw new CatError(`Unexpected reply from the radio: "${reply}"`);
  return id;
}

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');
const bit = (flag: unknown) => (flag ? '1' : '0');
const signed = (value: number, digits: number) =>
  `${value < 0 ? '-' : '+'}${pad(Math.abs(value), digits)}`;
const position = (list: readonly unknown[], value: unknown) => DIGITS[list.indexOf(value)] ?? '0';

type Encoders = {
  [K in SettingKey]: (value: SettingValue<K>, state: RadioState) => string;
};

/** The three display settings travel in one command, so the other two come from the state. */
function dimmerCommand(state: RadioState, change: Patch): string {
  const { contrast, dimmer, ledDimmer } = { ...state, ...change };
  if (contrast === null || dimmer === null || ledDimmer === null) {
    throw new CommandError('The display settings have not been read from the radio yet');
  }
  return `DA00${pad(contrast, 2)}${pad(dimmer, 2)}${pad(ledDimmer, 2)}`;
}

const ENCODERS: Encoders = {
  frequencyA: (hz) => `FA${pad(hz, 9)}`,
  frequencyB: (hz) => `FB${pad(hz, 9)}`,
  mainVfo: (vfo) => `VS${vfo === 'A' ? 0 : 1}`,
  modeMain: (mode) => `MD0${MODE_CODES[mode]}`,
  modeSub: (mode) => `MD1${MODE_CODES[mode]}`,
  split: (flag) => `ST${bit(flag)}`,
  txVfo: (vfo) => `FT${vfo === 'main' ? 0 : 1}`,
  clar: (clar) => `CF000${bit(clar.startsWith('rx'))}${bit(clar.endsWith('tx'))}000`,
  clarOffsetHz: (hz) => `CF001${signed(hz, 4)}`,
  fineTuning: (state) => `FN${FINE_TUNING.indexOf(state)}`,
  lock: (flag) => `LK${bit(flag)}`,

  afGain: (level) => `AG0${pad(level, 3)}`,
  rfGain: (level) => `RG0${pad(level, 3)}`,
  squelch: (level) => `SQ0${pad(level, 3)}`,
  // Any of the "auto" values selects automatic AGC; the radio picks the time constant.
  agc: (agc) => `GT0${agc.startsWith('auto') ? 4 : AGC_SET.indexOf(agc)}`,
  attenuator: (att) => `RA0${position(ATTENUATORS, att)}`,
  preamp: (amp) => `PA0${position(PREAMPS, amp)}`,
  noiseBlanker: (flag) => `NB0${bit(flag)}`,
  noiseBlankerLevel: (level) => `NL0${pad(level, 3)}`,
  noiseReduction: (flag) => `NR0${bit(flag)}`,
  noiseReductionLevel: (level) => `RL0${pad(level, 2)}`,
  autoNotch: (flag) => `BC0${bit(flag)}`,
  manualNotch: (flag) => `BP0000${bit(flag)}`,
  manualNotchHz: (hz) => `BP01${pad(hz / 10, 3)}`,
  contour: (flag) => `CO00000${bit(flag)}`,
  contourHz: (hz) => `CO01${pad(hz, 4)}`,
  apf: (flag) => `CO02000${bit(flag)}`,
  apfHz: (hz) => `CO03${pad(hz / 10 + 25, 4)}`,
  ifShiftHz: (hz) => `IS00${signed(hz, 4)}`,
  width: (width) => `SH00${pad(width, 2)}`,
  narrow: (flag) => `NA0${bit(flag)}`,

  power: (watts) => `PC${pad(watts, 3)}`,
  micGain: (level) => `MG${pad(level, 3)}`,
  processor: (flag) => `PR0${flag ? 2 : 1}`,
  processorLevel: (level) => `PL${pad(level, 3)}`,
  micEq: (flag) => `PR1${flag ? 2 : 1}`,
  monitor: (flag) => `ML000${bit(flag)}`,
  monitorLevel: (level) => `ML1${pad(level, 3)}`,
  amcLevel: (level) => `AO${pad(level, 3)}`,
  vox: (flag) => `VX${bit(flag)}`,
  voxGain: (level) => `VG${pad(level, 3)}`,
  voxDelay: (delay) => `VD${pad(delay, 2)}`,
  antiVox: (level) => `AV${pad(level, 3)}`,
  tuner: (flag) => `AC00${bit(flag)}`,
  mox: (flag) => `MX${bit(flag)}`,
  txw: (flag) => `TS${bit(flag)}`,
  txMeter: (meter) => `MS${position(TX_METERS, meter)}0`,

  keyer: (flag) => `KR${bit(flag)}`,
  keySpeed: (wpm) => `KS${pad(wpm, 3)}`,
  keyPitchHz: (hz) => `KP${pad((hz - 300) / 10, 2)}`,
  breakIn: (flag) => `BI${bit(flag)}`,
  breakInDelay: (delay) => `SD${pad(delay, 2)}`,
  cwSpot: (flag) => `CS${bit(flag)}`,

  ctcss: (state) => `CT0${CTCSS.indexOf(state)}`,
  ctcssTone: (tone) => `CN00${pad(tone, 3)}`,
  repeaterShift: (shift) => `OS0${REPEATER_SHIFTS.indexOf(shift)}`,

  scopeSpeed: (speed) => `SS00${position(SCOPE_SPEEDS, speed)}0000`,
  scopePeak: (peak) => `SS01${peak - 1}0000`,
  scopeMarker: (flag) => `SS02${bit(flag)}0000`,
  scopeColor: (color) => `SS03${DIGITS[color - 1]}0000`,
  scopeLevel: (level) =>
    `SS04${level < 0 ? '-' : '+'}${Math.abs(level).toFixed(1).padStart(4, '0')}`,
  scopeSpan: (span) => `SS05${span}0000`,
  scopeMode: (mode) => `SS06${DIGITS[mode]}0000`,
  contrast: (contrast, state) => dimmerCommand(state, { contrast }),
  dimmer: (dimmer, state) => dimmerCommand(state, { dimmer }),
  ledDimmer: (ledDimmer, state) => dimmerCommand(state, { ledDimmer }),
  funcKnob: (knob) => `SF0${position(FUNC_KNOB_FUNCTIONS, knob)}`,
  dspKnob: (knob) => `SF1${position(DSP_KNOB_FUNCTIONS, knob)}`,
  aessLevel: (level) => `AS1${pad(level, 3)}`,
  aessCutoff: (cutoff) => `AS2${cutoff === '1000Hz' ? '002' : '001'}`,
};

/** The CAT command that gives a setting a value. The value must already be validated. */
export function settingCommand<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  state: RadioState,
): string {
  return ENCODERS[key](value, state);
}

/** The read command whose reply carries each setting. */
export const SETTING_READS: Record<SettingKey, string> = {
  frequencyA: 'FA',
  frequencyB: 'FB',
  mainVfo: 'VS',
  modeMain: 'MD0',
  modeSub: 'MD1',
  split: 'ST',
  txVfo: 'FT',
  clar: 'CF000',
  clarOffsetHz: 'CF001',
  fineTuning: 'FN',
  lock: 'LK',
  afGain: 'AG0',
  rfGain: 'RG0',
  squelch: 'SQ0',
  agc: 'GT0',
  attenuator: 'RA0',
  preamp: 'PA0',
  noiseBlanker: 'NB0',
  noiseBlankerLevel: 'NL0',
  noiseReduction: 'NR0',
  noiseReductionLevel: 'RL0',
  autoNotch: 'BC0',
  manualNotch: 'BP00',
  manualNotchHz: 'BP01',
  contour: 'CO00',
  contourHz: 'CO01',
  apf: 'CO02',
  apfHz: 'CO03',
  ifShiftHz: 'IS0',
  width: 'SH0',
  narrow: 'NA0',
  power: 'PC',
  micGain: 'MG',
  processor: 'PR0',
  processorLevel: 'PL',
  micEq: 'PR1',
  monitor: 'ML0',
  monitorLevel: 'ML1',
  amcLevel: 'AO',
  vox: 'VX',
  voxGain: 'VG',
  voxDelay: 'VD',
  antiVox: 'AV',
  tuner: 'AC',
  mox: 'MX',
  txw: 'TS',
  txMeter: 'MS',
  keyer: 'KR',
  keySpeed: 'KS',
  keyPitchHz: 'KP',
  breakIn: 'BI',
  breakInDelay: 'SD',
  cwSpot: 'CS',
  ctcss: 'CT0',
  ctcssTone: 'CN00',
  repeaterShift: 'OS0',
  scopeSpeed: 'SS00',
  scopePeak: 'SS01',
  scopeMarker: 'SS02',
  scopeColor: 'SS03',
  scopeLevel: 'SS04',
  scopeSpan: 'SS05',
  scopeMode: 'SS06',
  contrast: 'DA',
  dimmer: 'DA',
  ledDimmer: 'DA',
  funcKnob: 'SF0',
  dspKnob: 'SF1',
  aessLevel: 'AS1',
  aessCutoff: 'AS2',
};

/** Read on every polling round: what moves while the radio is being operated. */
export const FAST_READS = ['FA', 'FB', 'RI0', 'SM0'];
/** Read on every polling round while transmitting: the transmit meters. */
export const TX_READS = ['RM5', 'RM6', 'RM4', 'RM3', 'RM7', 'RM8'];
/** Read once per connection. */
export const ONCE_READS = ['VE0'];
/** Read a few at a time, so that a change made on the radio itself shows up within seconds. */
export const SLOW_READS = [
  ...new Set(Object.values(SETTING_READS).filter((read) => !FAST_READS.includes(read))),
  'IF',
  'EX030102',
  'EX030501',
  'EX030502',
  'EX030503',
];

/** Settings and actions that can put the radio on the air. */
export function keysTransmitter(key: SettingKey, value: unknown): boolean {
  return (key === 'mox' || key === 'vox') && value === true;
}
export const TRANSMITTING_ACTIONS: readonly Action[] = ['tuneStart'];

/** The CAT commands that carry out an action. */
export function actionCommands(action: Action, value: number, state: RadioState): string[] {
  switch (action) {
    case 'swapVfo':
      return ['SV'];
    case 'copyMainToSub':
      return [state.mainVfo === 'B' ? 'BA' : 'AB'];
    case 'bandUp':
      return ['BU0'];
    case 'bandDown':
      return ['BD0'];
    case 'bandSelect':
      if (value < 0 || value > 11) throw new CommandError('There is no such band');
      return [`BS${pad(value, 2)}`];
    case 'memoryToVfo':
      return ['MA'];
    case 'vfoMemory':
      return ['VM'];
    case 'qmbStore':
      return ['QI'];
    case 'qmbRecall':
      return ['QR'];
    case 'channelUp':
      return ['CH0'];
    case 'channelDown':
      return ['CH1'];
    case 'zeroIn':
      return ['ZI0'];
    case 'tuneStart':
      return ['AC003'];
    case 'clarClear':
      return ['CF001+0000'];
    case 'dspReset':
      return ['IS00+0000', 'SH0000', 'BP00000', 'CO000000', 'CO020000'];
    case 'scanUp':
      return ['SC1'];
    case 'scanDown':
      return ['SC2'];
    case 'scanStop':
      return ['SC0'];
    case 'syncClock': {
      // The radio keeps UTC. toISOString gives "2026-10-06T21:30:05.000Z".
      const [date = '', time = ''] = new Date().toISOString().split('T');
      return [`DT0${date.replaceAll('-', '')}`, `DT1${time.slice(0, 8).replaceAll(':', '')}`];
    }
  }
}

/** Reads a memory channel's contents out of the reply to "MRnnn;"; null if it is not one. */
export function parseMemoryReply(reply: string): Omit<MemoryChannel, 'tag'> | null {
  // Channel, frequency, clarifier (offset, RX, TX), mode, then four more fields unused here.
  const match = /^MR(.{3})(\d{9})[+-]\d{4}[01][01](.)\d\d00\d$/.exec(reply);
  const mode = MODES_BY_CODE.get(match?.[3] ?? '');
  if (!match || !mode) return null;
  return { channel: match[1] ?? '', frequencyHz: Number(match[2]), mode };
}

/**
 * The command that stores a frequency and mode in a memory channel, with no clarifier or tone.
 * The field after the mode has to say "memory" (1): the radio refuses the command with the 0
 * that it itself reports there for a stored channel.
 */
export function memoryWriteCommand(channel: string, hz: number, mode: Mode): string {
  return `MW${channel}${pad(hz, 9)}+000000${MODE_CODES[mode]}10000`;
}

/** The name of a memory channel out of the reply to "MTnnn;"; empty if it has none. */
export function parseTagReply(reply: string): string {
  return /^MT.{3}[01](.{0,12})$/.exec(reply)?.[1]?.trimEnd() ?? '';
}

/** The command that names a memory channel and has the radio show the name. */
export function tagCommand(channel: string, tag: string): string {
  return `MT${channel}${tag === '' ? 0 : 1}${tag.padEnd(MEMORY_TAG_LENGTH)}`;
}

/** The text of a CW memory out of the reply to "KMn;". An empty memory answers a bare "KM". */
export function parseMessageReply(reply: string): string {
  return /^KM\d(.*)$/.exec(reply)?.[1] ?? '';
}

/**
 * The command that stores a text in a CW memory. Yaesu's manual says to end the text with
 * "}", but an FT-710 then keeps the brace as part of the text; it wants the text alone.
 * There is no way to store an empty text: the command without one is the read command.
 */
export function messageCommand(number: number, text: string): string {
  if (text === '') throw new CommandError('A CW memory cannot be emptied from the PC');
  return `KM${number}${text}`;
}
