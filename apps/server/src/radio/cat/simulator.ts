import {
  MAX_FREQUENCY_HZ,
  MENU,
  MIN_FREQUENCY_HZ,
  encodeMenuValue,
  type MenuItem,
} from '@radiobench/protocol';
import type { CatTransport, TransportHandlers } from './transport.ts';

const REPLY_DELAY_MS = 2;
const TUNING_CYCLE_MS = 1500;

/**
 * Settings the simulated radio holds, as [read command, value]. The read command followed by
 * a value is also the set command and the reply, which is how nearly all of the FT-710's
 * commands work. The values are what a real FT-710 answered, give or take.
 */
const SETTINGS: [read: string, value: string][] = [
  ['FA', '014074000'],
  ['FB', '003573800'],
  ['VS', '0'],
  ['MD0', 'C'],
  ['MD1', '1'],
  ['ST', '0'],
  ['FT', '0'],
  ['CF000', '00000'],
  ['CF001', '+0000'],
  ['FN', '0'],
  ['LK', '0'],
  ['AG0', '038'],
  ['RG0', '212'],
  ['SQ0', '000'],
  ['GT0', '5'],
  ['RA0', '0'],
  ['PA0', '1'],
  ['NB0', '0'],
  ['NL0', '005'],
  ['NR0', '0'],
  ['RL0', '01'],
  ['BC0', '0'],
  ['BP00', '000'],
  ['BP01', '150'],
  ['CO00', '0000'],
  ['CO01', '1500'],
  ['CO02', '0000'],
  ['CO03', '0025'],
  ['IS0', '0+0000'],
  ['SH0', '019'],
  ['NA0', '0'],
  ['PC', '100'],
  ['MG', '050'],
  ['PR0', '1'],
  ['PR1', '1'],
  ['PL', '050'],
  ['ML0', '000'],
  ['ML1', '050'],
  ['AO', '085'],
  ['VX', '0'],
  ['VG', '050'],
  ['VD', '08'],
  ['AV', '050'],
  ['AC', '001'],
  ['MX', '0'],
  ['TS', '0'],
  ['MS', '00'],
  ['KR', '0'],
  ['KS', '020'],
  ['KP', '40'],
  ['BI', '0'],
  ['SD', '04'],
  ['CS', '0'],
  ['CT0', '0'],
  ['CN00', '012'],
  ['OS0', '0'],
  ['SS00', '20000'],
  ['SS01', '00000'],
  ['SS02', '10000'],
  ['SS03', '90000'],
  ['SS04', '-15.0'],
  ['SS05', '60000'],
  ['SS06', '40000'],
  ['DA', '00151520'],
  ['SF0', 'D'],
  ['SF1', '1'],
  ['AS1', '050'],
  ['AS2', '001'],
  ['SC', '0'],
  ['MC', '001'],
  // The recorder: voice memory channel, receive recording, playback.
  ['LM0', '0'],
  ['LM1', '0'],
  ['PB0', '0'],
];

/** Menu values that differ from the first choice: both dial steps 10 Hz, channel step 5 kHz. */
const MENU_VALUES: Record<string, string> = { '030501': '1', '030502': '1', '030503': '2' };

/** A plausible value for a menu item: the first choice, the lowest number or no text. */
function menuDefault(item: MenuItem): string {
  const { value } = item;
  const start = value.kind === 'text' ? '' : value.kind === 'choice' ? 0 : Math.max(value.min, 0);
  return encodeMenuValue(item, start) ?? '0'.repeat(item.digits);
}

/** Where the band keys land: the FT8 frequency of each band. */
const BAND_FREQUENCIES_HZ = [
  1_840_000, 3_573_000, 5_357_000, 7_074_000, 10_136_000, 14_074_000, 18_100_000, 21_074_000,
  24_915_000, 28_074_000, 50_313_000, 70_154_000,
];

/** Commands that do something once and that the simulator merely accepts. */
const ACCEPTED = /^(ZI0|QI|QR|MA|AM|CH[01]|UP|DN|KY[01][0-5]|DT0\d{8}|DT1\d{6})$/;

/**
 * A stand-in FT-710 that answers the CAT commands RadioBench uses, so the app
 * and its tests run without the radio attached.
 */
export class SimulatedTransport implements CatTransport {
  private readonly settings = new Map(SETTINGS);
  private readonly menu = new Map(
    MENU.map((item) => [item.id, MENU_VALUES[item.id] ?? menuDefault(item)]),
  );
  /** Memory channels in use: what follows the channel number in the MR and MT replies. */
  private readonly memories = new Map([
    ['001', { content: '007000000+000000100000', tag: '0            ' }],
  ]);
  private readonly messages = ['', '', '', 'DE FT-710 K', 'R 5NN K'];
  private handlers: TransportHandlers | null = null;
  private buffer = '';
  private sMeter = 60;
  private tuningUntil = 0;
  private memoryMode = false;
  private off = false;
  private woken = false;

  async open(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async write(data: string): Promise<void> {
    this.buffer += data;
    for (;;) {
      const end = this.buffer.indexOf(';');
      if (end < 0) break;
      const command = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const reply = this.off ? this.whileOff(command) : this.execute(command);
      if (reply !== null) {
        setTimeout(() => this.handlers?.onData(`${reply};`), REPLY_DELAY_MS);
      }
    }
  }

  async close(): Promise<void> {
    this.handlers = null;
  }

  private get(read: string): string {
    return this.settings.get(read) ?? '';
  }

  private get transmitting(): boolean {
    return this.get('MX') === '1' || Date.now() < this.tuningUntil;
  }

  private mainFrequency(): 'FA' | 'FB' {
    return this.get('VS') === '0' ? 'FA' : 'FB';
  }

  /** Switched off, the radio hears only the command that switches it on, and needs it twice. */
  private whileOff(command: string): null {
    if (command !== 'PS1') return null;
    if (this.woken) this.off = false;
    this.woken = !this.woken;
    return null;
  }

  /** Returns the radio's reply, or null where the real radio stays silent. */
  private execute(command: string): string | null {
    const stored = this.settings.get(command);
    if (stored !== undefined) return command + stored;

    switch (command) {
      case 'ID':
        return 'ID0800';
      case 'VE0':
        return 'VE00112';
      case 'PS':
        return 'PS1';
      case 'PS0':
        this.off = true;
        this.woken = false;
        return null;
      case 'TX':
        return `TX${this.transmitting ? 1 : 0}`;
      case 'SM0':
        this.sMeter = Math.min(255, Math.max(0, this.sMeter + Math.round(Math.random() * 16 - 8)));
        return `SM0${String(this.sMeter).padStart(3, '0')}`;
      case 'RI0': {
        const recorder = this.get('LM1') === '1' ? 1 : this.get('PB0') === '0' ? 0 : 2;
        const tuning = Date.now() < this.tuningUntil ? 1 : 0;
        const scanning = this.get('SC') === '0' ? 0 : 1;
        return `RI00${recorder}${this.transmitting ? 1 : 0}0${tuning}${scanning}0`;
      }
      case 'IF':
      case 'OI': {
        const main = (command === 'IF') === (this.get('VS') === '0');
        const frequency = this.get(command === 'IF' ? 'FA' : 'FB');
        const clar = `${this.get('CF001')}${this.get('CF000').slice(0, 2)}`;
        const channel = this.memoryMode ? this.get('MC') : '000';
        const source = this.memoryMode ? 1 : 0;
        return `${command}${channel}${frequency}${clar}${this.get(main ? 'MD0' : 'MD1')}${source}0000`;
      }
      case 'VM':
        this.memoryMode = !this.memoryMode;
        return null;
      case 'SV':
        this.settings.set('VS', this.get('VS') === '0' ? '1' : '0');
        this.swap('MD0', 'MD1');
        return null;
      case 'AB':
      case 'BA': {
        const [from, to] = command === 'AB' ? ['FA', 'FB'] : ['FB', 'FA'];
        this.settings.set(to ?? '', this.get(from ?? ''));
        const fromMain = (from === 'FA') === (this.get('VS') === '0');
        this.settings.set(fromMain ? 'MD1' : 'MD0', this.get(fromMain ? 'MD0' : 'MD1'));
        return null;
      }
      case 'BU0':
      case 'BD0': {
        const hz = Number(this.get(this.mainFrequency()));
        const above = BAND_FREQUENCIES_HZ.findIndex((band) => band > hz);
        const count = BAND_FREQUENCIES_HZ.length;
        const here = (above < 0 ? count : above) - 1;
        const next =
          command === 'BU0' ? here + 1 : hz === BAND_FREQUENCIES_HZ[here] ? here - 1 : here;
        return this.goToBand((next + count) % count);
      }
    }

    const transmitMeter = /^RM([3-8])$/.exec(command);
    if (transmitMeter) {
      const power = this.transmitting ? Math.round(Number(this.get('PC')) * 2.1) : 0;
      const level = transmitMeter[1] === '5' ? power : transmitMeter[1] === '8' ? 210 : 0;
      return `${command}${String(level).padStart(3, '0')}000`;
    }
    const band = /^BS(\d\d)$/.exec(command);
    if (band) return this.goToBand(Number(band[1]));
    if (ACCEPTED.test(command)) return null;

    const memory = /^(MR|MT|MW)(.{3})(.*)$/.exec(command);
    if (memory) return this.memoryCommand(memory[1] ?? '', memory[2] ?? '', memory[3] ?? '');
    const message = /^KM([1-5])(.*)$/.exec(command);
    if (message) {
      const index = Number(message[1]) - 1;
      // Whatever follows the number is stored as the text, a closing brace included.
      if (message[2]) {
        this.messages[index] = message[2];
        return null;
      }
      // An empty memory answers without even its number.
      return this.messages[index] ? `KM${message[1]}${this.messages[index]}` : 'KM';
    }
    const menu = /^EX(\d{6})(.*)$/.exec(command);
    if (menu) {
      const [, id = '', value = ''] = menu;
      const held = this.menu.get(id);
      if (held === undefined) return '?';
      if (value === '') return `EX${id}${held}`;
      if (value.length !== held.length) return '?';
      this.menu.set(id, value);
      return null;
    }

    return this.store(command) ? null : '?';
  }

  /** The memory commands: MR reads a channel, MW writes one, MT reads or sets its name. */
  private memoryCommand(command: string, channel: string, rest: string): string | null {
    const held = this.memories.get(channel);
    if (command === 'MW') {
      // As on the real radio: the field after the mode must be 1, and reads back as 0.
      if (!/^\d{9}[+-]\d{4}[01][01].1\d00\d$/.test(rest)) return '?';
      const content = `${rest.slice(0, 17)}0${rest.slice(18)}`;
      this.memories.set(channel, { content, tag: held?.tag ?? '0            ' });
      return null;
    }
    if (!held) return '?';
    if (rest === '') return `${command}${channel}${command === 'MR' ? held.content : held.tag}`;
    if (command !== 'MT' || !/^[01].{12}$/.test(rest)) return '?';
    held.tag = rest;
    return null;
  }

  private swap(a: string, b: string): void {
    const kept = this.get(a);
    this.settings.set(a, this.get(b));
    this.settings.set(b, kept);
  }

  private goToBand(band: number): string | null {
    const hz = BAND_FREQUENCIES_HZ[band];
    if (hz === undefined) return '?';
    this.settings.set(this.mainFrequency(), String(hz).padStart(9, '0'));
    return null;
  }

  /** Takes a set command: a known read command followed by a value of the right shape. */
  private store(command: string): boolean {
    for (const [read, current] of this.settings) {
      if (!command.startsWith(read) || command.length !== read.length + current.length) continue;
      let value = command.slice(read.length);
      if (!/^[0-9A-Z+\-.]+$/.test(value)) return false;
      if (read === 'FA' || read === 'FB') {
        if (Number(value) < MIN_FREQUENCY_HZ || Number(value) > MAX_FREQUENCY_HZ) return false;
      }
      // Asked for automatic AGC, the radio reports the time constant it chose.
      if (read === 'GT0' && value === '4') value = '5';
      if (read === 'AC' && value === '003') {
        this.tuningUntil = Date.now() + TUNING_CYCLE_MS;
        value = '001';
      }
      this.settings.set(read, value);
      return true;
    }
    return false;
  }
}
