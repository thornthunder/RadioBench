/**
 * The FT-710's setting menu as the EX command reaches it: where each item sits, what the radio
 * calls it and how its value is written. Numbers and value formats are those of table 2 in
 * Yaesu's CAT Operation Reference Manual; names are those of the Operation Manual's menu tree.
 */
import { CTCSS_TONES_HZ } from './controls.ts';

/** How a menu item's value is written in the EX command. */
export type MenuValue =
  /**
   * The value is a position in `options`, written as a zero-padded number. An empty label
   * marks a position the radio does not use.
   */
  | { kind: 'choice'; options: readonly string[] }
  /**
   * The value is the number itself, zero-padded; a signed one carries "+" or "-" first.
   * Where the step is a fraction the decimal point is left out: 3.0 in steps of 0.1 is "30".
   */
  | { kind: 'number'; min: number; max: number; step: number; unit: string; signed: boolean }
  /** The value is text of up to maxLength characters. */
  | { kind: 'text'; maxLength: number };

export interface MenuItem {
  /** P1, P2 and P3 of the EX command, two digits each, e.g. "010118". */
  id: string;
  /** The setting screen, as the radio names it. */
  screen: MenuScreen;
  /** The group within the screen, as the radio names it, e.g. "MODE SSB". */
  group: string;
  /** The item, as the radio names it, e.g. "NAR WIDTH". */
  name: string;
  /** Number of characters of the value in the EX command. */
  digits: number;
  value: MenuValue;
}

export const MENU_SCREENS = [
  'RADIO SETTING',
  'CW SETTING',
  'OPERATION SETTING',
  'DISPLAY SETTING',
  'PRESET',
] as const;
export type MenuScreen = (typeof MENU_SCREENS)[number];

/** A menu item that has not been given its place in the menu yet. */
type Entry = Pick<MenuItem, 'name' | 'digits' | 'value'>;
type Group = readonly [name: string, entries: readonly Entry[]];

const choice = (name: string, options: readonly string[], digits = 1): Entry => ({
  name,
  digits,
  value: { kind: 'choice', options },
});
const number = (
  name: string,
  digits: number,
  min: number,
  max: number,
  step = 1,
  unit = '',
): Entry => ({ name, digits, value: { kind: 'number', min, max, step, unit, signed: false } });
/** A number written as a sign and two digits. */
const signed = (name: string, min: number, max: number): Entry => ({
  name,
  digits: 3,
  value: { kind: 'number', min, max, step: 1, unit: '', signed: true },
});
const text = (name: string): Entry => ({
  name,
  digits: 12,
  value: { kind: 'text', maxLength: 12 },
});
const level = (name: string): Entry => number(name, 3, 0, 100);
const offOn = (name: string): Entry => choice(name, ['OFF', 'ON']);

/** Labels for a list of values that share a unit. */
const withUnit = (values: readonly number[], unit: string): string[] =>
  values.map((value) => `${value}${unit}`);

/** Labels for the values from `from` to `to`, `step` apart. */
function stepped(from: number, to: number, step: number, unit: string): string[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return withUnit(values, unit);
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Numbers a screen's groups and their items in the order given, as the radio does. */
function screen(p1: number, name: MenuScreen, groups: readonly Group[]): MenuItem[] {
  return groups.flatMap(([group, entries], g) =>
    entries.map((entry, i) => ({
      id: two(p1) + two(g + 1) + two(i + 1),
      screen: name,
      group,
      ...entry,
    })),
  );
}

const SLOPES = ['6dB/oct', '18dB/oct'];
const PTT_LINES = ['OFF', 'RTS', 'DTR', 'DAKY'];
const CAT_RATES = withUnit([4800, 9600, 19200, 38400, 115200], 'bps');
const CAT_TIMEOUTS = withUnit([10, 100, 1000, 3000], 'msec');

/** What NAR WIDTH offers in SSB, and in the narrow modes: CW, RTTY, PSK and DATA. */
const SSB_NARROW_WIDTHS = withUnit(
  [
    300, 400, 600, 850, 1100, 1200, 1500, 1650, 1800, 1950, 2100, 2250, 2400, 2450, 2500, 2600,
    2700, 2800, 2900, 3000, 3200, 3500, 4000,
  ],
  'Hz',
);
const NARROW_WIDTHS = withUnit(
  [
    50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 800, 1200, 1400, 1700, 2000, 2400, 3000,
    3200, 3500, 4000,
  ],
  'Hz',
);

// The blocks of items that several groups have in common.

const agcDelay = (name: string): Entry => number(name, 4, 20, 4000, 20, 'ms');

/** AGC, audio filters and audio output levels: in every mode group and every preset. */
const agcFiltersOutputs = [
  agcDelay('AGC FAST DELAY'),
  agcDelay('AGC MID DELAY'),
  agcDelay('AGC SLOW DELAY'),
  choice('LCUT FREQ', ['OFF', ...stepped(100, 1000, 50, 'Hz')], 2),
  choice('LCUT SLOPE', SLOPES),
  choice('HCUT FREQ', ['OFF', ...stepped(700, 4000, 50, 'Hz')], 2),
  choice('HCUT SLOPE', SLOPES),
  level('USB OUT LEVEL'),
  level('REAR OUT LEVEL'),
];

/** Items 01 to 12 of every mode group: the receive audio. */
const receiveAudio = [
  signed('AF TREBLE GAIN', -20, 10),
  signed('AF MIDDLE TONE GAIN', -20, 10),
  signed('AF BASS GAIN', -20, 10),
  ...agcFiltersOutputs,
];

const txBpf = choice('TX BPF SEL', ['50-3050', '100-2900', '200-2800', '300-2700', '400-2600']);
const modulation = [
  choice('MOD SOURCE', ['MIC', 'USB', 'REAR', 'AUTO']),
  level('USB MOD GAIN'),
  level('REAR MOD GAIN'),
];
const rptt = choice('RPTT SELECT', PTT_LINES);

/** The settings of one CAT port; CAT-1's are in GENERAL and in every preset. */
const catPort = (port: string): Entry[] => [
  choice(`${port} RATE`, CAT_RATES),
  choice(`${port} TIME OUT TIMER`, CAT_TIMEOUTS),
];
const catStopBit = choice('CAT-1 CAT-3 STOP BIT', ['1bit', '2bit']);

/**
 * The three bands of a parametric microphone equalizer. There are two equalizers: the second,
 * named with a "P " in front, is the one in use while the speech processor is on.
 */
const equalizer = (prefix: string): Entry[] =>
  (
    [
      [100, 700],
      [700, 1500],
      [1500, 3200],
    ] as const
  ).flatMap(([from, to], band) => {
    const name = `${prefix}PRMTRC EQ${band + 1}`;
    return [
      choice(`${name} FREQ`, ['OFF', ...stepped(from, to, 100, 'Hz')], 2),
      signed(`${name} LEVEL`, -20, 10),
      number(`${name} BWTH`, 2, 0, 10),
    ];
  });

/** What a key of the microphone can be made to do. */
const MIC_KEY_FUNCTIONS = [
  'LOCK',
  'QMB',
  'A/B',
  'V/M',
  'TUNER',
  'VOX/MOX',
  'MODE',
  'ZIN_SPOT',
  'SPLIT',
  'FINE',
  'NAR',
  'NB',
  'DNR',
  'FREQ UP',
  'FREQ DOWN',
  'BAND UP',
  'BAND DOWN',
  'ATT',
  'IPO',
  'DNF',
  'AGC',
];
const micKeys = ['MIC P1', 'MIC P2', 'MIC P3', 'MIC P4', 'MIC UP', 'MIC DOWN'].map((name) =>
  choice(name, MIC_KEY_FUNCTIONS, 2),
);

const KEYBOARD_LANGUAGES = [
  'JAPANESE',
  'ENGLISH(US)',
  'ENGLISH(UK)',
  'FRENCH',
  'FRENCH(CA)',
  'GERMAN',
  'PORTUGUESE',
  'PORTUGUESE(BR)',
  'SPANISH',
  'SPANISH(LATAM)',
  'ITALIAN',
];

const VFO_COLORS = ['BLUE', 'GREEN', 'RED', 'NONE'];

/** The items of a preset: a name, and the settings that a digital mode such as FT8 calls for. */
const preset = [
  text('PRESET NAME'),
  ...catPort('CAT-1'),
  catStopBit,
  ...agcFiltersOutputs,
  txBpf,
  ...modulation,
  rptt,
];

export const MENU: readonly MenuItem[] = [
  ...screen(1, 'RADIO SETTING', [
    [
      'MODE SSB',
      [
        ...receiveAudio,
        txBpf,
        ...modulation,
        rptt,
        choice('NAR WIDTH', SSB_NARROW_WIDTHS, 2),
        choice('CW AUTO MODE', ['OFF', '50M', 'ON']),
      ],
    ],
    ['MODE AM', [...receiveAudio, txBpf, ...modulation, rptt]],
    [
      'MODE FM',
      [
        ...receiveAudio,
        ...modulation,
        rptt,
        choice('RPT SHIFT', ['-', 'SIMP', '+']),
        number('RPT SHIFT(28MHz)', 4, 0, 1000, 10, 'kHz'),
        number('RPT SHIFT(50MHz)', 4, 0, 4000, 10, 'kHz'),
        choice('ENC/DEC', ['OFF', 'ENC', 'TSQ']),
        choice(
          'TONE FREQ',
          CTCSS_TONES_HZ.map((hz) => `${hz.toFixed(1)}Hz`),
          // Three characters on the radio, though the manual's table says two.
          3,
        ),
      ],
    ],
    [
      'MODE PSK/DATA',
      [
        ...receiveAudio,
        txBpf,
        ...modulation,
        rptt,
        choice('NAR WIDTH', NARROW_WIDTHS, 2),
        choice('PSK TONE', withUnit([1000, 1500, 2000], 'Hz')),
        number('DATA SHIFT (SSB)', 4, 0, 3000, 10, 'Hz'),
      ],
    ],
    [
      'MODE RTTY',
      [
        ...receiveAudio,
        rptt,
        choice('NAR WIDTH', NARROW_WIDTHS, 2),
        // The manual numbers these from 1, but the radio counts from 0 as everywhere else: one
        // left at its default of 2125Hz answers "1".
        choice('MARK FREQUENCY', ['1275Hz', '2125Hz']),
        choice('SHIFT FREQUENCY', withUnit([170, 200, 425, 850], 'Hz')),
        choice('POLARITY TX', ['NOR', 'REV']),
      ],
    ],
  ]),

  ...screen(2, 'CW SETTING', [
    [
      'MODE CW',
      [
        ...receiveAudio,
        rptt,
        choice('NAR WIDTH', NARROW_WIDTHS, 2),
        choice('PC KEYING', PTT_LINES),
        choice('CW BK-IN TYPE', ['SEMI', 'FULL']),
        choice('CW WAVE SHAPE', withUnit([4, 6, 8], 'msec')),
        choice('CW FREQ DISPLAY', ['DIRECT FREQ', 'PITCH OFFSET']),
        choice('QSK DELAY TIME', withUnit([15, 20, 25, 30], 'msec')),
        offOn('CW INDICATOR'),
      ],
    ],
    [
      'KEYER',
      [
        choice('KEYER TYPE', ['OFF', 'BUG', 'ELEKEY-A', 'ELEKEY-B', 'ELEKEY-Y', 'ACS']),
        choice('KEYER DOT/DASH', ['NOR', 'REV']),
        // The dash to dot ratio, 2.5 to 4.5 in tenths, numbered from 0: the radio answers "05"
        // for its default of 3.0.
        choice(
          'CW WEIGHT',
          Array.from({ length: 21 }, (_, tenths) => (2.5 + tenths / 10).toFixed(1)),
          2,
        ),
        choice('NUMBER STYLE', ['1290', 'AUNO', 'AUNT', 'A2NO', 'A2NT', '12NO', '12NT']),
        number('CONTEST NUMBER', 4, 1, 9999),
        ...[1, 2, 3, 4, 5].map((n) => choice(`CW MEMORY ${n}`, ['TEXT', 'MESSAGE'])),
        number('REPEAT INTERVAL', 2, 1, 60, 1, 's'),
      ],
    ],
  ]),

  ...screen(3, 'OPERATION SETTING', [
    [
      'GENERAL',
      [
        level('BEEP LEVEL'),
        choice('RF/SQL VR', ['RF', 'SQL', 'SQL(FM only)']),
        choice('TUN/LIN PORT SELECT', ['EXT-TUNER', 'LINEAR', 'CAT-3', 'GP OUT']),
        choice('TUNER TYPE SELECT', ['INT', 'INT(FAST)', 'EXT', 'ATAS']),
        ...catPort('CAT-1'),
        catStopBit,
        ...catPort('CAT-2'),
        ...catPort('CAT-3'),
        choice('QMB CH', ['5ch', '10ch']),
        offOn('BAND STACK'),
        offOn('MEM GROUP'),
        choice('TX TIME OUT TIMER', ['OFF', ...stepped(1, 30, 1, 'min')], 2),
        // The manual's table has ON first here, but a radio with this at its default of ON
        // answers "1": OFF comes first, as everywhere else.
        choice('MIC SCAN', ['OFF', 'ON']),
        choice('MIC SCAN RESUME', ['PAUSE', 'TIME']),
        signed('REF FREQ FINE ADJ', -25, 25),
        choice('KEYBOARD LANGUAGE', KEYBOARD_LANGUAGES, 2),
        ...micKeys,
        offOn('SCU-LAN10'),
      ],
    ],
    [
      'RX DSP',
      [
        choice('IF NOTCH WIDTH', ['NARROW', 'WIDE']),
        choice('NB REJECTION', ['LOW', 'MID', 'HIGH']),
        choice('NB WIDTH', ['NARROW', 'MEDIUM', 'WIDE']),
        choice('APF WIDTH', ['NARROW', 'MEDIUM', 'WIDE']),
        signed('CONTOUR LEVEL', -40, 20),
        number('CONTOUR WIDTH', 2, 1, 11),
      ],
    ],
    [
      'TX AUDIO',
      [choice('AMC RELEASE TIME', ['FAST', 'MID', 'SLOW']), ...equalizer(''), ...equalizer('P ')],
    ],
    [
      'TX GENERAL',
      [
        number('HF MAX POWER', 3, 5, 100, 1, 'W'),
        number('50M MAX POWER', 3, 5, 100, 1, 'W'),
        number('70M MAX POWER', 3, 5, 50, 1, 'W'),
        number('AM MAX POWER', 3, 5, 25, 1, 'W'),
        choice('VOX SELECT', ['MIC', 'USB', 'REAR']),
        offOn('EMERGENCY FREQ TX'),
        offOn('TX INHIBIT'),
        choice('METER DETECTOR', ['AVERAGE', 'PEAK']),
      ],
    ],
    [
      'TUNING',
      [
        choice('SSB/CW DIAL STEP', withUnit([5, 10, 20], 'Hz')),
        choice('RTTY/PSK DIAL STEP', withUnit([5, 10, 20], 'Hz')),
        choice('CH STEP', withUnit([1, 2.5, 5, 10], 'kHz')),
        choice('AM CH STEP', withUnit([2.5, 5, 9, 10, 12.5, 25], 'kHz')),
        choice('FM CH STEP', withUnit([5, 6.25, 10, 12.5, 20, 25], 'kHz')),
        choice('MAIN STEPS PER REV.', ['50', '100', '200']),
      ],
    ],
  ]),

  ...screen(4, 'DISPLAY SETTING', [
    [
      'DISPLAY',
      [
        text('MY CALL'),
        choice('MY CALL TIME', ['OFF', ...stepped(1, 5, 1, 'sec')]),
        // In the Operation Manual and on the radio, though the CAT manual's table leaves it out.
        choice('POP-UP TIME', ['FAST', 'MID', 'SLOW']),
        choice('SCREEN SAVER', ['OFF', ...withUnit([15, 30, 60], 'min')]),
        // The radio shows 0 as OFF.
        number('LED DIMMER', 2, 0, 20),
        number('MOUSE POINTER SPEED', 2, 0, 20),
      ],
    ],
    [
      'SCOPE',
      [
        choice('RBW', ['HIGH', 'MID', 'LOW']),
        choice('SCOPE CTR', ['FILTER', 'CAR POINT']),
        choice('2D DISP SENSITIVITY', ['NORMAL', 'HI']),
        choice('3DSS DISP SENSITIVITY', ['NORMAL', 'HI']),
      ],
    ],
    [
      'VFO IND COLOR',
      [
        choice('VMI COLOR VFO-A', VFO_COLORS),
        choice('VMI COLOR VFO-B', VFO_COLORS),
        choice('VMI COLOR MEMORY', ['BLUE', 'GREEN', 'WHITE', 'NONE']),
        choice('VMI COLOR CLAR', ['RED', 'NONE']),
      ],
    ],
    ['EXT MONITOR', [offOn('EXT DISPLAY'), choice('PIXEL', ['800x480', '800x600'])]],
  ]),

  // Screen 05, EXTENSION SETTING, is out of the EX command's reach.

  ...screen(
    6,
    'PRESET',
    [1, 2, 3, 4, 5].map((n): Group => [`PRESET${n}`, preset]),
  ),
];

const MENU_BY_ID = new Map(MENU.map((item) => [item.id, item]));

export function findMenuItem(id: string): MenuItem | undefined {
  return MENU_BY_ID.get(id);
}

type ChoiceValue = Extract<MenuValue, { kind: 'choice' }>;
type NumberValue = Extract<MenuValue, { kind: 'number' }>;

/** The label at a position of a choice; none where the radio has no such option. */
function optionLabel(spec: ChoiceValue, position: number): string | undefined {
  return spec.options[position] || undefined;
}

const decimalsOf = (n: number): number => (String(n).split('.')[1] ?? '').length;

/**
 * A number's range counted in the whole numbers that the EX command carries: values times
 * `scale`, which is 1 unless the step is a fraction.
 */
function wireRange(spec: NumberValue): { scale: number; min: number; max: number; step: number } {
  const scale = 10 ** decimalsOf(spec.step);
  return {
    scale,
    min: Math.round(spec.min * scale),
    max: Math.round(spec.max * scale),
    step: Math.round(spec.step * scale),
  };
}

/** Text the radio can hold: printable ASCII without the ";" that ends a CAT command. */
const PRINTABLE = /^[\x20-\x3a\x3c-\x7e]*$/;

/** The characters that stand for a value in the EX command; null if the item cannot take it. */
export function encodeMenuValue(item: MenuItem, value: number | string): string | null {
  const spec = item.value;
  switch (spec.kind) {
    case 'choice':
      if (typeof value !== 'number' || optionLabel(spec, value) === undefined) return null;
      return String(value).padStart(item.digits, '0');
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const { scale, min, max, step } = wireRange(spec);
      const wire = Math.round(value * scale);
      if (Math.abs(value * scale - wire) > 1e-9) return null;
      if (wire < min || wire > max || (wire - min) % step !== 0) return null;
      const figures = String(Math.abs(wire));
      if (!spec.signed) return figures.padStart(item.digits, '0');
      return (wire < 0 ? '-' : '+') + figures.padStart(item.digits - 1, '0');
    }
    case 'text':
      if (typeof value !== 'string' || value.length > spec.maxLength) return null;
      return PRINTABLE.test(value) ? value.padEnd(item.digits, ' ') : null;
  }
}

/**
 * What the characters of an EX reply stand for: an option's position, a number or text; null
 * if malformed.
 */
export function decodeMenuValue(item: MenuItem, raw: string): number | string | null {
  const spec = item.value;
  switch (spec.kind) {
    case 'choice': {
      if (raw.length !== item.digits || !/^\d+$/.test(raw)) return null;
      const position = Number(raw);
      return optionLabel(spec, position) === undefined ? null : position;
    }
    case 'number': {
      const shape = spec.signed ? /^[+-]\d+$/ : /^\d+$/;
      if (raw.length !== item.digits || !shape.test(raw)) return null;
      const { scale, min, max } = wireRange(spec);
      const wire = Number(raw);
      if (wire < min || wire > max) return null;
      // Zero may come with either sign.
      return wire === 0 ? 0 : wire / scale;
    }
    case 'text': {
      // Shorter text is taken as it is, in case the radio does not pad what it sends.
      if (raw.length > item.digits || !PRINTABLE.test(raw)) return null;
      const trimmed = raw.trimEnd();
      return trimmed.length > spec.maxLength ? null : trimmed;
    }
  }
}

/** A value worded for display: the option's label, or the number with its unit. */
export function menuValueText(item: MenuItem, value: number | string): string {
  const spec = item.value;
  if (typeof value === 'string') return value;
  switch (spec.kind) {
    case 'choice':
      return optionLabel(spec, value) ?? String(value);
    case 'number':
      return value.toFixed(decimalsOf(spec.step)) + spec.unit;
    case 'text':
      return String(value);
  }
}
