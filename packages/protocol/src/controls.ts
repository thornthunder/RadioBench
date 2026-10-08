/**
 * Every setting of the radio that RadioBench can read and change, with the values it may
 * take. The server validates commands against this table and the web client takes its
 * ranges and option lists from it, so a setting is described in exactly one place.
 */

/** Operating modes, named as on the FT-710's display. */
export const MODES = [
  'LSB',
  'USB',
  'CW-L',
  'CW-U',
  'AM',
  'AM-N',
  'FM',
  'FM-N',
  'DATA-L',
  'DATA-U',
  'DATA-FM',
  'D-FM-N',
  'RTTY-L',
  'RTTY-U',
  'PSK',
] as const;
export type Mode = (typeof MODES)[number];

/** Receive coverage of the FT-710. */
export const MIN_FREQUENCY_HZ = 30_000;
export const MAX_FREQUENCY_HZ = 75_000_000;

/** What the [FUNC] knob can be assigned to, in the order of the radio's own numbering. */
export const FUNC_KNOB_FUNCTIONS = [
  'NONE',
  'LEVEL',
  'PEAK',
  'COLOR',
  'CONTRAST',
  'DIMMER',
  'M-GROUP',
  'MIC GAIN',
  'PROC LEVEL',
  'AMC LEVEL',
  'VOX GAIN',
  'VOX DELAY',
  'ANTI VOX',
  'RF POWER',
  'MONI LEVEL',
  'CW SPEED',
  'CW PITCH',
  'BK-DELAY',
] as const;
export type FuncKnobFunction = (typeof FUNC_KNOB_FUNCTIONS)[number];

/** What the [STEP·MCH/DSP] knob adjusts once pressed, in the radio's own numbering. */
export const DSP_KNOB_FUNCTIONS = ['NONE', 'SHIFT', 'WIDTH', 'NOTCH', 'CONTOUR', 'APF'] as const;
export type DspKnobFunction = (typeof DSP_KNOB_FUNCTIONS)[number];

export const SCOPE_SPEEDS = ['SLOW1', 'SLOW2', 'FAST1', 'FAST2', 'FAST3', 'STOP'] as const;
export const TX_METERS = ['PO', 'COMP', 'ALC', 'VDD', 'ID', 'SWR'] as const;

export interface BoolSpec {
  kind: 'bool';
}
export interface NumberSpec {
  kind: 'number';
  min: number;
  max: number;
  step: number;
}
export interface EnumSpec<V extends string> {
  kind: 'enum';
  values: readonly V[];
}
export type ControlSpec = BoolSpec | NumberSpec | EnumSpec<string>;

const bool: BoolSpec = { kind: 'bool' };
const number = (min: number, max: number, step = 1): NumberSpec => ({
  kind: 'number',
  min,
  max,
  step,
});
const oneOf = <const V extends string>(values: readonly V[]): EnumSpec<V> => ({
  kind: 'enum',
  values,
});

export const CONTROLS = {
  // VFOs
  frequencyA: number(MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ),
  frequencyB: number(MIN_FREQUENCY_HZ, MAX_FREQUENCY_HZ),
  /** Which VFO is the main one: the upper, white frequency on the display. */
  mainVfo: oneOf(['A', 'B']),
  modeMain: oneOf(MODES),
  modeSub: oneOf(MODES),
  split: bool,
  /** Which of the two frequencies transmits. */
  txVfo: oneOf(['main', 'sub']),
  /** Clarifier: which of receive and transmit are shifted by clarOffsetHz. */
  clar: oneOf(['off', 'rx', 'tx', 'rxtx']),
  clarOffsetHz: number(-9995, 9995),
  fineTuning: oneOf(['off', 'fine', 'fast']),
  lock: bool,

  // Receiver
  afGain: number(0, 255),
  rfGain: number(0, 255),
  squelch: number(0, 100),
  /** "auto" is only ever set; the radio reports which automatic time constant is in effect. */
  agc: oneOf(['off', 'fast', 'mid', 'slow', 'auto', 'auto-fast', 'auto-mid', 'auto-slow']),
  attenuator: oneOf(['OFF', '6dB', '12dB', '18dB']),
  preamp: oneOf(['IPO', 'AMP1', 'AMP2']),
  noiseBlanker: bool,
  noiseBlankerLevel: number(0, 10),
  noiseReduction: bool,
  noiseReductionLevel: number(1, 15),
  /** DNF, the automatic notch. */
  autoNotch: bool,
  manualNotch: bool,
  manualNotchHz: number(10, 3200, 10),
  contour: bool,
  contourHz: number(10, 3200, 10),
  apf: bool,
  apfHz: number(-250, 250, 10),
  ifShiftHz: number(-1200, 1200, 20),
  /** Position in the radio's list of filter widths; see widthHz(). 0 is the mode's default. */
  width: number(0, 23),
  narrow: bool,

  // Transmitter
  power: number(5, 100),
  micGain: number(0, 100),
  processor: bool,
  processorLevel: number(1, 100),
  micEq: bool,
  monitor: bool,
  monitorLevel: number(0, 100),
  amcLevel: number(1, 100),
  vox: bool,
  voxGain: number(0, 100),
  /** Position in the radio's list of delays; see delayMs(). */
  voxDelay: number(0, 33),
  antiVox: number(0, 100),
  /** The antenna tuner being in circuit; starting a tuning cycle is an action. */
  tuner: bool,
  mox: bool,
  txw: bool,
  txMeter: oneOf(TX_METERS),

  // CW
  keyer: bool,
  keySpeed: number(4, 60),
  keyPitchHz: number(300, 1050, 10),
  breakIn: bool,
  /** Position in the radio's list of delays; see delayMs(). */
  breakInDelay: number(0, 33),
  cwSpot: bool,

  // FM
  ctcss: oneOf(['off', 'enc-dec', 'enc']),
  /** Position in CTCSS_TONES_HZ. */
  ctcssTone: number(0, 49),
  repeaterShift: oneOf(['simplex', 'plus', 'minus']),

  // Scope and display
  scopeSpeed: oneOf(SCOPE_SPEEDS),
  scopePeak: number(1, 5),
  scopeMarker: bool,
  scopeColor: number(1, 11),
  scopeLevel: number(-30, 30, 0.5),
  /** Position in SCOPE_SPANS_HZ. */
  scopeSpan: number(0, 9),
  /** The radio's scope mode number; see describeScopeMode(). */
  scopeMode: number(0, 10),
  contrast: number(0, 20),
  dimmer: number(0, 20),
  ledDimmer: number(0, 20),
  funcKnob: oneOf(FUNC_KNOB_FUNCTIONS),
  dspKnob: oneOf(DSP_KNOB_FUNCTIONS),
  aessLevel: number(0, 100),
  aessCutoff: oneOf(['700Hz', '1000Hz']),
} as const;

export type SettingKey = keyof typeof CONTROLS;

type ValueOf<S> = S extends BoolSpec
  ? boolean
  : S extends NumberSpec
    ? number
    : S extends EnumSpec<infer V>
      ? V
      : never;

/** The radio's settings as last read from it; null where a value is not known (yet). */
export type Settings = { [K in SettingKey]: ValueOf<(typeof CONTROLS)[K]> | null };
export type SettingValue<K extends SettingKey> = NonNullable<Settings[K]>;

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.hasOwn(CONTROLS, key);
}

/** Whether the value is one the setting can take. */
export function isValidSetting(key: SettingKey, value: unknown): boolean {
  const spec: ControlSpec = CONTROLS[key];
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value);
    case 'number': {
      if (typeof value !== 'number' || value < spec.min || value > spec.max) return false;
      const steps = (value - spec.min) / spec.step;
      return Math.abs(steps - Math.round(steps)) < 1e-9;
    }
  }
}

/** The value a number of knob clicks away, kept within the setting's range. */
export function stepSetting(key: SettingKey, current: number, clicks: number): number {
  const spec: ControlSpec = CONTROLS[key];
  if (spec.kind !== 'number') return current;
  const stepped = current + clicks * spec.step;
  return Math.min(spec.max, Math.max(spec.min, Math.round(stepped / spec.step) * spec.step));
}

/** Things the radio does once when asked, as opposed to settings that keep a value. */
export const ACTIONS = [
  /** The [A/B] key: the other VFO becomes the main one. */
  'swapVfo',
  /** [A/B] held: the sub VFO takes on the main VFO's frequency and mode. */
  'copyMainToSub',
  'bandUp',
  'bandDown',
  /** Jump to a band; the value is a position in BANDS. */
  'bandSelect',
  /** The [M►V] key. */
  'memoryToVfo',
  /** The [V/M] key. */
  'vfoMemory',
  'qmbStore',
  'qmbRecall',
  'channelUp',
  'channelDown',
  /** [ZIN]: tune a received CW signal to zero beat. */
  'zeroIn',
  /** Start an antenna tuning cycle. The radio transmits a carrier while it tunes. */
  'tuneStart',
  /** Set the clarifier offset back to zero. */
  'clarClear',
  /** [DSP RESET] held: shift, width, notch, contour and APF back to their defaults. */
  'dspReset',
  'scanUp',
  'scanDown',
  'scanStop',
  /** Sets the radio's clock to the server's time, in UTC as the radio keeps it. */
  'syncClock',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Bands of the radio's band selection screen, in its own numbering. */
export const BANDS = [
  '1.8',
  '3.5',
  '5',
  '7',
  '10',
  '14',
  '18',
  '21',
  '24.5',
  '28',
  '50',
  '70/GEN',
] as const;

export const SCOPE_SPANS_HZ = [
  1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
] as const;

export interface ScopeModeInfo {
  view: '3DSS' | 'waterfall';
  /** How the sweep is placed: around the receive frequency, scrolling with it, or fixed. */
  placement: 'CENTER' | 'CURSOR' | 'FIX';
  /** The enlarged waterfall view. The 3DSS view has no such variant. */
  expanded: boolean;
}

const PLACEMENTS = ['CENTER', 'CURSOR', 'FIX'] as const;

/** Takes the radio's scope mode number apart. */
export function describeScopeMode(mode: number): ScopeModeInfo {
  if (mode <= 2) {
    return { view: '3DSS', placement: PLACEMENTS[mode] ?? 'CENTER', expanded: false };
  }
  // Waterfall modes come in threes: enlarged, normal, and an unused number.
  const group = Math.floor((mode - 3) / 3);
  return {
    view: 'waterfall',
    placement: PLACEMENTS[group] ?? 'CENTER',
    expanded: (mode - 3) % 3 === 0,
  };
}

/** The radio's scope mode number for a combination of view, placement and size. */
export function scopeModeNumber(info: ScopeModeInfo): number {
  const placement = PLACEMENTS.indexOf(info.placement);
  if (info.view === '3DSS') return placement;
  return 3 + placement * 3 + (info.expanded ? 0 : 1);
}

const SSB_WIDTHS_HZ = [
  300, 400, 600, 850, 1100, 1200, 1500, 1650, 1800, 1950, 2100, 2250, 2400, 2450, 2500, 2600, 2700,
  2800, 2900, 3000, 3200, 3500, 4000,
];
const NARROW_MODE_WIDTHS_HZ = [
  50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 800, 1200, 1400, 1700, 2000, 2400, 3000,
  3500, 4000,
];
const FIXED_WIDTHS_HZ: Partial<Record<Mode, number>> = {
  AM: 9000,
  'AM-N': 6000,
  FM: 16000,
  'FM-N': 9000,
  'DATA-FM': 16000,
  'D-FM-N': 9000,
};

/** The width settings a mode offers, narrowest first; empty where the width is fixed. */
export function widthsHz(mode: Mode): readonly number[] {
  if (mode in FIXED_WIDTHS_HZ) return [];
  return mode === 'LSB' || mode === 'USB' ? SSB_WIDTHS_HZ : NARROW_MODE_WIDTHS_HZ;
}

/** The filter bandwidth a width setting stands for in a mode. */
export function widthHz(mode: Mode, width: number): number {
  const fixed = FIXED_WIDTHS_HZ[mode];
  if (fixed !== undefined) return fixed;
  const listed = widthsHz(mode)[width - 1];
  if (listed !== undefined) return listed;
  // Setting 0 is the mode's default width.
  if (mode === 'LSB' || mode === 'USB') return 3000;
  return mode.startsWith('DATA') || mode === 'PSK' ? 600 : 500;
}

/** The time a VOX or break-in delay setting stands for. */
export function delayMs(setting: number): number {
  return [30, 50, 100, 150, 200, 250][setting] ?? (setting - 3) * 100;
}

export const CTCSS_TONES_HZ = [
  67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2,
  110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5,
  167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7,
  218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
] as const;
