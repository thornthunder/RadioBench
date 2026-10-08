import { describe, expect, test } from 'vitest';
import {
  MENU,
  MENU_SCREENS,
  decodeMenuValue,
  encodeMenuValue,
  findMenuItem,
  menuValueText,
  type MenuItem,
} from './menu.ts';

function item(id: string): MenuItem {
  const found = findMenuItem(id);
  if (!found) throw new Error(`no menu item ${id}`);
  return found;
}

function options(id: string): readonly string[] {
  const { value } = item(id);
  if (value.kind !== 'choice') throw new Error(`menu item ${id} is not a choice`);
  return value.options;
}

/** P1 and P2, the screen, the group and its number of items, as the CAT manual's table has them. */
const GROUPS = [
  ['0101', 'RADIO SETTING', 'MODE SSB', 19],
  ['0102', 'RADIO SETTING', 'MODE AM', 17],
  ['0103', 'RADIO SETTING', 'MODE FM', 21],
  ['0104', 'RADIO SETTING', 'MODE PSK/DATA', 20],
  ['0105', 'RADIO SETTING', 'MODE RTTY', 17],
  ['0201', 'CW SETTING', 'MODE CW', 20],
  ['0202', 'CW SETTING', 'KEYER', 11],
  ['0301', 'OPERATION SETTING', 'GENERAL', 26],
  ['0302', 'OPERATION SETTING', 'RX DSP', 6],
  ['0303', 'OPERATION SETTING', 'TX AUDIO', 19],
  ['0304', 'OPERATION SETTING', 'TX GENERAL', 8],
  ['0305', 'OPERATION SETTING', 'TUNING', 6],
  ['0401', 'DISPLAY SETTING', 'DISPLAY', 6],
  ['0402', 'DISPLAY SETTING', 'SCOPE', 4],
  ['0403', 'DISPLAY SETTING', 'VFO IND COLOR', 4],
  ['0404', 'DISPLAY SETTING', 'EXT MONITOR', 2],
  ['0601', 'PRESET', 'PRESET1', 18],
  ['0602', 'PRESET', 'PRESET2', 18],
  ['0603', 'PRESET', 'PRESET3', 18],
  ['0604', 'PRESET', 'PRESET4', 18],
  ['0605', 'PRESET', 'PRESET5', 18],
] as const;

describe('the menu table', () => {
  test('gives every item an id of its own, six digits long', () => {
    const ids = MENU.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{6}$/);
    expect(ids).toEqual([...ids].sort());
  });

  test('has the groups of the manual, each numbered from 01 without gaps', () => {
    const groups = new Map<string, { screen: string; group: string; count: number }>();
    for (const entry of MENU) {
      const key = entry.id.slice(0, 4);
      const seen = groups.get(key) ?? { screen: entry.screen, group: entry.group, count: 0 };
      groups.set(key, seen);
      // One screen and one group name per P1 and P2, and P3 counting up from 01.
      expect([entry.screen, entry.group]).toEqual([seen.screen, seen.group]);
      seen.count += 1;
      expect(Number(entry.id.slice(4))).toBe(seen.count);
    }
    const found = [...groups].map(([key, { screen, group, count }]) => [key, screen, group, count]);
    expect(found).toEqual(GROUPS);
    expect(MENU).toHaveLength(296);
  });

  test('knows no screen but the five the EX command reaches', () => {
    for (const entry of MENU) expect(MENU_SCREENS).toContain(entry.screen);
    expect(MENU.some((entry) => entry.id.startsWith('05'))).toBe(false);
  });

  test('allows each value as many characters as it needs', () => {
    for (const entry of MENU) {
      const { value, digits, id } = entry;
      switch (value.kind) {
        case 'choice':
          expect(value.options.length, id).toBeGreaterThan(1);
          expect(value.options.length, id).toBeLessThanOrEqual(10 ** digits);
          break;
        case 'number':
          expect(value.min, id).toBeLessThan(value.max);
          expect(encodeMenuValue(entry, value.min), id).toHaveLength(digits);
          expect(encodeMenuValue(entry, value.max), id).toHaveLength(digits);
          break;
        case 'text':
          expect(value.maxLength, id).toBeLessThanOrEqual(digits);
          break;
      }
    }
  });

  test('places items where the manual has them', () => {
    expect(item('010118')).toMatchObject({ group: 'MODE SSB', name: 'NAR WIDTH', digits: 2 });
    expect(item('010217').name).toBe('RPTT SELECT');
    expect(item('010313').name).toBe('MOD SOURCE');
    expect(item('010321').name).toBe('TONE FREQ');
    expect(item('010420').name).toBe('DATA SHIFT (SSB)');
    expect(item('010517').name).toBe('POLARITY TX');
    expect(item('020115').name).toBe('PC KEYING');
    expect(item('020211').name).toBe('REPEAT INTERVAL');
    expect(item('030119').name).toBe('KEYBOARD LANGUAGE');
    expect(item('030125').name).toBe('MIC DOWN');
    expect(item('030126').name).toBe('SCU-LAN10');
    expect(item('030206').name).toBe('CONTOUR WIDTH');
    expect(item('030311').name).toBe('P PRMTRC EQ1 FREQ');
    expect(item('030319').name).toBe('P PRMTRC EQ3 BWTH');
    expect(item('030408').name).toBe('METER DETECTOR');
    expect(item('040101')).toMatchObject({ screen: 'DISPLAY SETTING', name: 'MY CALL' });
    expect(item('040103').name).toBe('POP-UP TIME');
    expect(item('040106').name).toBe('MOUSE POINTER SPEED');
    expect(item('040304').name).toBe('VMI COLOR CLAR');
    expect(item('040402').name).toBe('PIXEL');
    expect(item('060301')).toMatchObject({ screen: 'PRESET', group: 'PRESET3' });
    expect(item('060518').name).toBe('RPTT SELECT');
    expect(findMenuItem('050101')).toBeUndefined();
    expect(findMenuItem('010120')).toBeUndefined();
  });

  test('gives the five presets the same items', () => {
    const preset = (n: number) =>
      MENU.filter((entry) => entry.group === `PRESET${n}`).map(({ name, digits, value }) => ({
        name,
        digits,
        value,
      }));
    for (const n of [2, 3, 4, 5]) expect(preset(n)).toEqual(preset(1));
  });

  test('writes out the lists the manual gives as a rule', () => {
    const lowCut = options('010107');
    expect(lowCut).toHaveLength(20);
    expect([lowCut[0], lowCut[1], lowCut[19]]).toEqual(['OFF', '100Hz', '1000Hz']);

    const highCut = options('010109');
    expect(highCut).toHaveLength(68);
    expect([highCut[0], highCut[1], highCut[67]]).toEqual(['OFF', '700Hz', '4000Hz']);

    expect(options('030302')).toHaveLength(8);
    expect(options('030305').at(-1)).toBe('1500Hz');
    const eq3 = options('030308');
    expect([eq3[1], eq3[6], eq3[18]]).toEqual(['1500Hz', '2000Hz', '3200Hz']);
    expect(eq3).toHaveLength(19);

    const timeOut = options('030115');
    expect(timeOut).toHaveLength(31);
    expect([timeOut[0], timeOut[1], timeOut[30]]).toEqual(['OFF', '1min', '30min']);

    const tones = options('010321');
    expect(tones).toHaveLength(50);
    expect([tones[0], tones[12], tones[49]]).toEqual(['67.0Hz', '100.0Hz', '254.1Hz']);

    expect(options('010118')).toHaveLength(23);
    expect(options('010418')).toHaveLength(21);
    expect(options('030120')).toHaveLength(21);
  });
});

describe('menu values', () => {
  test('survive encoding and decoding, for every item', () => {
    for (const entry of MENU) {
      const { value, digits, id } = entry;
      const samples: (number | string)[] = [];
      switch (value.kind) {
        case 'choice':
          value.options.forEach((label, position) => {
            if (label !== '') samples.push(position);
          });
          break;
        case 'number': {
          const steps = Math.round((value.max - value.min) / value.step);
          samples.push(value.min, value.min + Math.floor(steps / 2) * value.step, value.max);
          break;
        }
        case 'text':
          samples.push('', 'A', 'FT-710', 'ABCDEFGHIJKL'.slice(0, value.maxLength));
          break;
      }
      for (const sample of samples) {
        const raw = encodeMenuValue(entry, sample);
        expect(raw, `${id} ${sample}`).toHaveLength(digits);
        const decoded = decodeMenuValue(entry, raw ?? '');
        if (typeof sample === 'number') expect(decoded, `${id} ${raw}`).toBeCloseTo(sample, 9);
        else expect(decoded, `${id} ${raw}`).toBe(sample);
      }
    }
  });

  test('read what the radio was seen to answer', () => {
    // EX0301030; EX0305012; EX0305032;
    const port = item('030103');
    expect(port).toMatchObject({ group: 'GENERAL', name: 'TUN/LIN PORT SELECT' });
    expect(decodeMenuValue(port, '0')).toBe(0);
    expect(menuValueText(port, 0)).toBe('EXT-TUNER');

    const dialStep = item('030501');
    expect(dialStep).toMatchObject({ group: 'TUNING', name: 'SSB/CW DIAL STEP' });
    expect(decodeMenuValue(dialStep, '2')).toBe(2);
    expect(menuValueText(dialStep, 2)).toBe('20Hz');

    const channelStep = item('030503');
    expect(channelStep.name).toBe('CH STEP');
    expect(decodeMenuValue(channelStep, '2')).toBe(2);
    expect(menuValueText(channelStep, 2)).toBe('5kHz');
  });

  test('write a signed number with its sign first', () => {
    const treble = item('010101');
    expect(encodeMenuValue(treble, 5)).toBe('+05');
    expect(encodeMenuValue(treble, -20)).toBe('-20');
    expect(encodeMenuValue(treble, 10)).toBe('+10');
    expect(encodeMenuValue(treble, 0)).toBe('+00');
    expect(encodeMenuValue(treble, -0)).toBe('+00');

    expect(decodeMenuValue(treble, '+05')).toBe(5);
    expect(decodeMenuValue(treble, '-20')).toBe(-20);
    expect(decodeMenuValue(treble, '+00')).toBe(0);
    expect(decodeMenuValue(treble, '-00')).toBe(0);

    for (const value of [11, -21, 0.5, Number.NaN, '+05']) {
      expect(encodeMenuValue(treble, value)).toBeNull();
    }
    for (const raw of ['+11', '-21', '005', '+5', '+005', '+0a', '']) {
      expect(decodeMenuValue(treble, raw)).toBeNull();
    }

    const contour = item('030205');
    expect(encodeMenuValue(contour, -40)).toBe('-40');
    expect(encodeMenuValue(contour, 20)).toBe('+20');
    expect(decodeMenuValue(contour, '-15')).toBe(-15);
  });

  test('keep a number to its range and step', () => {
    const agcDelay = item('010104');
    expect(encodeMenuValue(agcDelay, 20)).toBe('0020');
    expect(encodeMenuValue(agcDelay, 300)).toBe('0300');
    expect(encodeMenuValue(agcDelay, 4000)).toBe('4000');
    for (const value of [0, 310, 4020, -20, 300.5, Number.POSITIVE_INFINITY, '0300']) {
      expect(encodeMenuValue(agcDelay, value)).toBeNull();
    }
    expect(decodeMenuValue(agcDelay, '0300')).toBe(300);
    for (const raw of ['300', '00300', '0000', '9999', '03a0', '+300', ' 300']) {
      expect(decodeMenuValue(agcDelay, raw)).toBeNull();
    }

    const power = item('030401');
    expect(encodeMenuValue(power, 5)).toBe('005');
    expect(encodeMenuValue(power, 100)).toBe('100');
    expect(encodeMenuValue(power, 4)).toBeNull();
    expect(decodeMenuValue(item('030404'), '025')).toBe(25);
    expect(decodeMenuValue(item('030404'), '026')).toBeNull();

    const shift = item('010319');
    expect(encodeMenuValue(shift, 1000)).toBe('1000');
    expect(encodeMenuValue(shift, 1005)).toBeNull();
  });

  test('fit what a real FT-710 answered where the manual was unclear or wrong', () => {
    // CW WEIGHT: "05" at its default of 3.0.
    const weight = item('020203');
    expect(weight.name).toBe('CW WEIGHT');
    expect(menuValueText(weight, decodeMenuValue(weight, '05') ?? -1)).toBe('3.0');
    expect(encodeMenuValue(weight, 20)).toBe('20');
    expect(menuValueText(weight, 20)).toBe('4.5');
    expect(encodeMenuValue(weight, 21)).toBeNull();
    // MARK FREQUENCY and MIC SCAN at their defaults both answered "1".
    expect(menuValueText(item('010515'), decodeMenuValue(item('010515'), '1') ?? -1)).toBe(
      '2125Hz',
    );
    expect(menuValueText(item('030116'), decodeMenuValue(item('030116'), '1') ?? -1)).toBe('ON');
    // TONE FREQ takes three characters, and DISPLAY has a POP-UP TIME the CAT manual omits.
    expect(decodeMenuValue(item('010321'), '012')).toBe(12);
    expect(decodeMenuValue(item('040105'), '20')).toBe(20);
    expect(decodeMenuValue(item('040106'), '10')).toBe(10);
  });

  test('take a choice by its position only', () => {
    const tone = item('010321');
    expect(encodeMenuValue(tone, 0)).toBe('000');
    expect(encodeMenuValue(tone, 12)).toBe('012');
    expect(encodeMenuValue(tone, 49)).toBe('049');
    for (const value of [50, -1, 1.5, Number.NaN, '100.0Hz', '12']) {
      expect(encodeMenuValue(tone, value)).toBeNull();
    }
    expect(decodeMenuValue(tone, '049')).toBe(49);
    for (const raw of ['050', '05', '0049', '04x', '+04', '']) {
      expect(decodeMenuValue(tone, raw)).toBeNull();
    }

    const slope = item('010108');
    expect(encodeMenuValue(slope, 1)).toBe('1');
    expect(encodeMenuValue(slope, 2)).toBeNull();
    expect(decodeMenuValue(slope, '2')).toBeNull();
  });

  test('skip a position that a list does not use', () => {
    const oneBased: MenuItem = {
      ...item('010515'),
      value: { kind: 'choice', options: ['', 'FIRST', 'SECOND'] },
    };
    expect(encodeMenuValue(oneBased, 0)).toBeNull();
    expect(encodeMenuValue(oneBased, 2)).toBe('2');
    expect(decodeMenuValue(oneBased, '0')).toBeNull();
    expect(decodeMenuValue(oneBased, '1')).toBe(1);
    expect(menuValueText(oneBased, 2)).toBe('SECOND');
    expect(menuValueText(oneBased, 0)).toBe('0');
  });

  test('pad text with spaces and trim it again', () => {
    for (const id of ['040101', '060101', '060501']) {
      const name = item(id);
      expect(name.value).toEqual({ kind: 'text', maxLength: 12 });
      expect(encodeMenuValue(name, 'FT-710')).toBe('FT-710      ');
      expect(encodeMenuValue(name, 'ABCDEFGHIJKL')).toBe('ABCDEFGHIJKL');
      expect(encodeMenuValue(name, '')).toBe('            ');
      // Too long, the character that ends a CAT command, not ASCII, not printable, not text.
      for (const value of ['ABCDEFGHIJKLM', 'AB;CD', 'GRÜSSE', 'A\tB', 5]) {
        expect(encodeMenuValue(name, value)).toBeNull();
      }

      expect(decodeMenuValue(name, 'FT-710      ')).toBe('FT-710');
      expect(decodeMenuValue(name, 'MY  CALL    ')).toBe('MY  CALL');
      expect(decodeMenuValue(name, 'FT-710')).toBe('FT-710');
      expect(decodeMenuValue(name, '            ')).toBe('');
      expect(decodeMenuValue(name, 'ABCDEFGHIJKLM')).toBeNull();
      expect(decodeMenuValue(name, 'FT-710\u0000     ')).toBeNull();
    }
  });

  test('are worded for display', () => {
    expect(menuValueText(item('010104'), 300)).toBe('300ms');
    expect(menuValueText(item('030401'), 100)).toBe('100W');
    expect(menuValueText(item('010318'), 100)).toBe('100kHz');
    expect(menuValueText(item('020211'), 5)).toBe('5s');
    expect(menuValueText(item('010101'), -5)).toBe('-5');
    expect(menuValueText(item('030101'), 20)).toBe('20');
    expect(menuValueText(item('010113'), 0)).toBe('50-3050');
    expect(menuValueText(item('010317'), 1)).toBe('SIMP');
    expect(menuValueText(item('040101'), 'FT-710')).toBe('FT-710');
    // A position without an option is shown as the number it is.
    expect(menuValueText(item('010108'), 7)).toBe('7');
  });
});
