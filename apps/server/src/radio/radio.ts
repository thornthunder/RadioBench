import {
  CONTROLS,
  CW_MESSAGES,
  MEMORY_CHANNELS,
  type Action,
  type MemoryChannel,
  type RadioState,
  type SettingKey,
  type SettingValue,
  type Settings,
} from '@radiobench/protocol';
import { AUTO_BAUD, AUTO_PORT, SIM_PORT, type CatConfig } from '../config.ts';
import { errorText, pause } from '../util.ts';
import { CatClient } from './cat/client.ts';
import {
  FAST_READS,
  FT710_ID,
  ONCE_READS,
  SETTING_READS,
  SLOW_READS,
  TRANSMITTING_ACTIONS,
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
  type Patch,
} from './cat/codec.ts';
import { CatError, CatTimeoutError, CommandError } from './cat/errors.ts';
import { SerialTransport, findCatPort } from './cat/serial.ts';
import { SimulatedTransport } from './cat/simulator.ts';
import type { CatTransport } from './cat/transport.ts';

const RECONNECT_DELAY_MS = 2000;
/** Pause between polling rounds, so the radio is not kept answering without a break. */
const POLL_PAUSE_MS = 30;
/** Slowly changing settings read per polling round; a full pass takes a few seconds. */
const SLOW_READS_PER_ROUND = 4;
/** Unanswered reads in a row after which the link is taken to be down. */
const MAX_TIMEOUTS = 3;
/** MOX is released after this long, in case whoever switched it on has gone away. */
export const MAX_MOX_MS = 3 * 60_000;

/** The choices of the radio's CAT-1 RATE menu item, factory default first. */
const BAUD_RATES = [38400, 9600, 19200, 4800, 115200];

const PAUSE = Symbol('pause');

/** Settings whose change brings other settings with it: each mode and VFO keeps its own. */
const RESHAPING: ReadonlySet<SettingKey> = new Set(['modeMain', 'modeSub', 'mainVfo']);

const TX_SWITCHED_OFF =
  'Transmit controls are switched off on the server. Set RADIOBENCH_TX=on to enable them.';
const REFUSED = 'The radio did not accept that. It may not apply in the present mode.';
const NOT_CONNECTED = 'The radio is not connected';

/** Gap between the two commands that switch the radio on: the first only wakes it. */
const WAKE_GAP_MS = 1200;
/** How long the radio is given to start up before the link is tried again. */
const WAKE_BOOT_MS = 5000;

type StateListener = (state: RadioState, patch: Patch) => void;
type MenuListener = (id: string, raw: string) => void;
type TransportFactory = (path: string, baudRate: number, stopBits: 1 | 2) => CatTransport;

type Job = { resolve(): void; reject(error: Error): void } & (
  | { kind: 'set'; key: SettingKey; value: boolean | number | string }
  | { kind: 'action'; action: Action; value: number }
  // An exchange of several commands and replies, which reports its own result.
  | { kind: 'task'; run(client: CatClient): Promise<void> }
);

interface Link {
  transport: CatTransport;
  client: CatClient;
}

const openTransport: TransportFactory = (path, baudRate, stopBits) =>
  path === SIM_PORT ? new SimulatedTransport() : new SerialTransport(path, baudRate, stopBits);

/** Baud rates to try, in order: just the configured one, or all of them with the last good one first. */
export function baudRatesToTry(
  configured: CatConfig['baudRate'],
  lastGood: number | null,
): number[] {
  if (configured !== AUTO_BAUD) return [configured];
  if (lastGood === null) return BAUD_RATES;
  return [lastGood, ...BAUD_RATES.filter((rate) => rate !== lastGood)];
}

/** Asks for the radio's model ID; null when nothing intelligible comes back. */
async function identify(client: CatClient): Promise<string | null> {
  // The second try is for a radio still holding stray characters from a probe at another
  // speed: it answers "?;" to those, then the repeated command gets through.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return parseIdReply(await client.query('ID'));
    } catch (error) {
      if (!(error instanceof CatError)) throw error;
      if (error instanceof CatTimeoutError) return null;
    }
  }
  return null;
}

/** Sends a read command; null where the radio refuses it, as it does for what does not exist. */
async function ask(client: CatClient, command: string): Promise<string | null> {
  try {
    return await client.query(command);
  } catch (error) {
    if (error instanceof CatError && !(error instanceof CatTimeoutError)) return null;
    throw error;
  }
}

/** Reads one memory channel with its name; null if the channel is empty. */
async function readMemory(client: CatClient, channel: string): Promise<MemoryChannel | null> {
  const memory = parseMemoryReply((await ask(client, `MR${channel}`)) ?? '');
  if (!memory) return null;
  return { ...memory, tag: parseTagReply((await ask(client, `MT${channel}`)) ?? '') };
}

function unknownSettings(): Settings {
  return Object.fromEntries(Object.keys(CONTROLS).map((key) => [key, null])) as Settings;
}

/** Everything read from the radio, as it is before anything has been read. */
function nothingRead(): Omit<RadioState, 'link' | 'linkError' | 'port' | 'txEnabled'> {
  return {
    ...unknownSettings(),
    transmitting: false,
    hiSwr: false,
    busy: false,
    tuning: false,
    scanning: false,
    recording: false,
    playing: false,
    vfoState: null,
    memoryChannel: null,
    sMeter: null,
    meterPo: null,
    meterSwr: null,
    meterAlc: null,
    meterComp: null,
    meterId: null,
    meterVdd: null,
    dialStepSsbCwHz: null,
    dialStepDataHz: null,
    channelStepHz: null,
    rfSqlKnob: null,
    firmware: null,
  };
}

/**
 * Owns the link to the radio: keeps it connected, keeps reading what the front panel shows,
 * and carries out commands. Everything the clients see is in its state.
 *
 * All traffic to the radio runs through one loop that sends waiting commands first and
 * otherwise works through the read commands, the fast-moving ones every round and the rest a
 * few per round.
 */
export class Radio {
  private readonly config: CatConfig;
  private readonly createTransport: TransportFactory;
  private readonly maxMoxMs: number;
  private readonly listeners = new Set<StateListener>();
  private readonly menuListeners = new Set<MenuListener>();
  private state: RadioState;
  private connected = false;
  /** Set when the radio is to be switched on before the link is tried next. */
  private wakeRequested = false;
  private jobs: Job[] = [];
  /** Reads to do before the next scheduled one, to confirm what a command did. */
  private urgentReads: string[] = [];
  /** Set when every setting should be read afresh. */
  private refreshAll = true;
  private moxTimer: NodeJS.Timeout | null = null;
  private lastGoodBaudRate: number | null = null;
  private abort: AbortController | null = null;
  private finished: Promise<void> = Promise.resolve();

  constructor(
    config: CatConfig,
    options: { txEnabled?: boolean; maxMoxMs?: number; createTransport?: TransportFactory } = {},
  ) {
    this.config = config;
    this.createTransport = options.createTransport ?? openTransport;
    this.maxMoxMs = options.maxMoxMs ?? MAX_MOX_MS;
    this.state = {
      link: 'disconnected',
      linkError: null,
      port: null,
      txEnabled: options.txEnabled ?? false,
      ...nothingRead(),
    };
  }

  getState(): RadioState {
    return this.state;
  }

  /** Calls the listener on every state change; returns a function that unsubscribes it. */
  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts connecting; from here on the link is re-established whenever it drops. */
  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.finished = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.finished;
    this.abort = null;
  }

  /** Gives a setting a new value. Resolves once the radio has taken it. */
  set<K extends SettingKey>(key: K, value: SettingValue<K>): Promise<void> {
    if (keysTransmitter(key, value) && !this.state.txEnabled) {
      return Promise.reject(new Error(TX_SWITCHED_OFF));
    }
    return this.enqueue((done) => {
      // Turning a knob sends values faster than the radio takes them: only the latest counts.
      const waiting = this.jobs.find((job) => job.kind === 'set' && job.key === key);
      if (waiting?.kind === 'set') {
        waiting.resolve();
        Object.assign(waiting, { value, ...done });
        return null;
      }
      return { kind: 'set', key, value, ...done };
    });
  }

  /** Has the radio do something once, such as changing band. */
  act(action: Action, value = 0): Promise<void> {
    if (TRANSMITTING_ACTIONS.includes(action) && !this.state.txEnabled) {
      return Promise.reject(new Error(TX_SWITCHED_OFF));
    }
    return this.enqueue((done) => ({ kind: 'action', action, value, ...done }));
  }

  private enqueue(makeJob: (done: Pick<Job, 'resolve' | 'reject'>) => Job | null): Promise<void> {
    if (!this.connected) return Promise.reject(new Error(NOT_CONNECTED));
    return new Promise((resolve, reject) => {
      const job = makeJob({ resolve, reject });
      if (job) this.jobs.push(job);
    });
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (this.wakeRequested) await this.wake(signal);
        await this.session(signal);
      } catch (error) {
        this.update({ link: 'disconnected', linkError: errorText(error), ...nothingRead() });
      }
      await pause(RECONNECT_DELAY_MS, signal);
    }
    this.update({ link: 'disconnected', linkError: null, ...nothingRead() });
  }

  /** One connection to the radio, from opening the port until it fails or we are stopped. */
  private async session(signal: AbortSignal): Promise<void> {
    const path = await this.resolvePort();
    // The reason the last try failed stays on show until this one succeeds.
    this.update({ link: 'connecting', port: path });
    const { transport, client } = await this.connect(path, signal);
    try {
      this.connected = true;
      this.refreshAll = true;
      this.update({ link: 'connected', linkError: null });
      await this.converse(client, signal);
    } finally {
      this.connected = false;
      await this.releaseMox(client);
      for (const job of this.jobs.splice(0)) job.reject(new Error(NOT_CONNECTED));
      this.urgentReads = [];
      await transport.close();
    }
  }

  /**
   * Switches the radio on. A radio that is off does not answer, so this cannot go through the
   * usual channels: the port is opened just to send the command, twice, because the first one
   * only wakes the radio's processor.
   */
  private async wake(signal: AbortSignal): Promise<void> {
    this.wakeRequested = false;
    const path = await this.resolvePort();
    this.update({ link: 'connecting', linkError: 'Switching the radio on…', port: path });
    // The speed is the one that worked before; failing that, each one the radio might be set to.
    const rates = baudRatesToTry(this.config.baudRate, this.lastGoodBaudRate);
    for (const baudRate of this.lastGoodBaudRate === null ? rates : rates.slice(0, 1)) {
      const transport = this.createTransport(path, baudRate, this.config.stopBits);
      await transport.open({ onData: () => {}, onClose: () => {} });
      try {
        await transport.write('PS1;');
        await pause(WAKE_GAP_MS, signal);
        await transport.write('PS1;');
      } finally {
        await transport.close();
      }
    }
    await pause(WAKE_BOOT_MS, signal);
  }

  /** The traffic of a session: commands as they come, reads the rest of the time. */
  private async converse(client: CatClient, signal: AbortSignal): Promise<void> {
    const scheduled = this.schedule();
    let timeouts = 0;
    while (!signal.aborted) {
      const job = this.jobs.shift();
      if (job) {
        await this.carryOut(client, job);
        continue;
      }
      const read = this.urgentReads.shift() ?? scheduled.next().value;
      if (read === PAUSE) {
        await pause(POLL_PAUSE_MS, signal);
        continue;
      }
      try {
        await client.query(read);
        timeouts = 0;
      } catch (error) {
        // The radio answers "?;" to a read that does not apply in its present mode.
        if (!(error instanceof CatError)) throw error;
        if (error instanceof CatTimeoutError && ++timeouts >= MAX_TIMEOUTS) {
          throw new Error(`The radio on ${this.state.port} has stopped answering`);
        }
      }
    }
  }

  /** The read commands in the order they are to be sent, without end. */
  private *schedule(): Generator<string | typeof PAUSE, never> {
    yield* ONCE_READS;
    let next = 0;
    for (;;) {
      if (this.refreshAll) {
        this.refreshAll = false;
        // One read at a time even here, so that commands still get in between.
        yield* SLOW_READS;
      }
      yield* FAST_READS;
      if (this.state.transmitting) yield* TX_READS;
      for (let i = 0; i < SLOW_READS_PER_ROUND; i++) {
        yield SLOW_READS[next++ % SLOW_READS.length] ?? PAUSE;
      }
      yield PAUSE;
    }
  }

  private async carryOut(client: CatClient, job: Job): Promise<void> {
    try {
      if (job.kind === 'task') {
        await job.run(client);
      } else {
        const commands =
          job.kind === 'set'
            ? [settingCommand(job.key, job.value as never, this.state)]
            : actionCommands(job.action, job.value, this.state);
        try {
          for (const command of commands) await client.set(command);
        } finally {
          this.readBack(job);
        }
        if (job.kind === 'set') {
          this.update({ [job.key]: job.value } as Patch);
          if (job.key === 'mox') this.watchMox(job.value === true);
          if (RESHAPING.has(job.key)) this.refreshAll = true;
        }
      }
      job.resolve();
    } catch (error) {
      if (error instanceof CatError) {
        job.reject(new Error(REFUSED));
      } else if (error instanceof CommandError) {
        job.reject(error);
      } else {
        // Anything else means the link itself has failed, which ends the session.
        job.reject(new Error(NOT_CONNECTED));
        throw error;
      }
    }
  }

  /** Runs an exchange with the radio in its turn among the other traffic. */
  private task<T>(run: (client: CatClient) => Promise<T>): Promise<T> {
    if (!this.connected) return Promise.reject(new Error(NOT_CONNECTED));
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        kind: 'task',
        run: async (client) => resolve(await run(client)),
        resolve: () => {},
        reject,
      });
    });
  }

  /** Reads the memory channels that are in use. This takes a second or two. */
  listMemories(): Promise<MemoryChannel[]> {
    return this.task(async (client) => {
      const channels: MemoryChannel[] = [];
      for (let number = 1; number <= MEMORY_CHANNELS; number++) {
        const memory = await readMemory(client, String(number).padStart(3, '0'));
        if (memory) channels.push(memory);
      }
      return channels;
    });
  }

  /** Puts the radio on a memory channel. */
  recallMemory(channel: string): Promise<void> {
    return this.task(async (client) => {
      await client.set(`MC${channel}`);
      // Selecting a channel does not by itself leave the VFO; the [V/M] key does.
      await ask(client, 'IF');
      if (this.state.vfoState === 'vfo') await client.set('VM');
      this.refreshAll = true;
      for (const read of ['IF', 'MD0']) this.readSoon(read);
    });
  }

  /** Stores the main VFO's frequency and mode in a memory channel. */
  storeMemory(channel: string): Promise<MemoryChannel | null> {
    return this.task(async (client) => {
      const hz = this.state.mainVfo === 'B' ? this.state.frequencyB : this.state.frequencyA;
      const mode = this.state.modeMain;
      if (hz === null || mode === null) {
        throw new CommandError('The frequency has not been read from the radio yet');
      }
      await client.set(memoryWriteCommand(channel, hz, mode));
      return readMemory(client, channel);
    });
  }

  /** Names a memory channel; an empty name removes the name. */
  tagMemory(channel: string, tag: string): Promise<MemoryChannel | null> {
    return this.task(async (client) => {
      await client.set(tagCommand(channel, tag));
      return readMemory(client, channel);
    });
  }

  /** Reads the radio's CW text memories, first to last. */
  listMessages(): Promise<string[]> {
    return this.task(async (client) => {
      const texts: string[] = [];
      for (let number = 1; number <= CW_MESSAGES; number++) {
        texts.push(parseMessageReply((await ask(client, `KM${number}`)) ?? ''));
      }
      return texts;
    });
  }

  storeMessage(number: number, text: string): Promise<void> {
    return this.task((client) => client.set(messageCommand(number, text)));
  }

  /** Sends a CW text memory on the air; 0 stops one that is being sent. */
  playMessage(number: number): Promise<void> {
    if (number > 0 && !this.state.txEnabled) return Promise.reject(new Error(TX_SWITCHED_OFF));
    return this.task((client) => client.set(`KY0${number}`));
  }

  /** Plays a voice memory on the air; 0 stops one that is playing. */
  playVoice(number: number): Promise<void> {
    if (number > 0 && !this.state.txEnabled) return Promise.reject(new Error(TX_SWITCHED_OFF));
    return this.task((client) => client.set(`PB0${number}`));
  }

  /** Starts or stops the radio's recording of the received audio to its SD card. */
  record(on: boolean): Promise<void> {
    return this.task((client) => client.set(`LM1${on ? 1 : 0}`));
  }

  /** Calls the listener with every menu value the radio reports: the item's id and the value's characters. */
  onMenu(listener: MenuListener): () => void {
    this.menuListeners.add(listener);
    return () => this.menuListeners.delete(listener);
  }

  /** Asks the radio for menu values; they arrive through onMenu. Items it lacks are skipped. */
  readMenu(ids: string[]): Promise<void> {
    return this.task(async (client) => {
      for (const id of ids) await ask(client, `EX${id}`);
    });
  }

  /** Gives a menu item a value, written as the characters the EX command takes. */
  setMenu(id: string, raw: string): Promise<void> {
    return this.task(async (client) => {
      try {
        await client.set(`EX${id}${raw}`);
      } finally {
        await ask(client, `EX${id}`);
      }
    });
  }

  /**
   * Switches the radio off or on. Off is an ordinary command, after which the radio stops
   * answering. On is sent the next time the link is tried, as there is no link to send it over.
   */
  power(on: boolean): Promise<void> {
    if (!on) return this.task((client) => client.set('PS0'));
    if (!this.connected) this.wakeRequested = true;
    return Promise.resolve();
  }

  /** Has the radio asked what a command left it with. */
  private readBack(job: Job): void {
    if (job.kind === 'task') return;
    if (job.kind === 'set') {
      this.readSoon(SETTING_READS[job.key]);
      return;
    }
    // An action can change frequency, mode and all that goes with them.
    this.refreshAll = true;
    for (const read of ['VS', 'MD0', 'MD1', 'IF']) this.readSoon(read);
  }

  private readSoon(read: string): void {
    // What is read every round anyway needs no extra read.
    if (FAST_READS.includes(read) || this.urgentReads.includes(read)) return;
    this.urgentReads.push(read);
  }

  /** Releases MOX after its time limit, whoever switched it on. */
  private watchMox(on: boolean): void {
    if (this.moxTimer) clearTimeout(this.moxTimer);
    this.moxTimer = on
      ? setTimeout(() => void this.set('mox', false).catch(() => undefined), this.maxMoxMs)
      : null;
  }

  /** Makes sure a session does not end with the transmitter keyed by us. */
  private async releaseMox(client: CatClient): Promise<void> {
    if (!this.moxTimer) return;
    this.watchMox(false);
    await client.set('MX0').catch(() => undefined);
  }

  private async resolvePort(): Promise<string> {
    if (this.config.port !== AUTO_PORT) return this.config.port;
    const found = await findCatPort();
    if (!found) throw new Error('No FT-710 found. Is its USB cable connected?');
    return found;
  }

  /** Opens the port at each candidate baud rate until an FT-710 answers. */
  private async connect(path: string, signal: AbortSignal): Promise<Link> {
    const rates = baudRatesToTry(this.config.baudRate, this.lastGoodBaudRate);
    for (const baudRate of rates) {
      if (signal.aborted) break;
      const transport = this.createTransport(path, baudRate, this.config.stopBits);
      const client = new CatClient(transport, (message) => {
        const patch = decode(message);
        if (patch) this.update(patch);
        // Menu values are too many to keep in the state; they go to whoever asked for them.
        const menu = /^EX(\d{6})(.+)$/.exec(message);
        if (menu) {
          for (const listener of this.menuListeners) listener(menu[1] ?? '', menu[2] ?? '');
        }
      });
      try {
        await transport.open({
          onData: (chunk) => client.receive(chunk),
          onClose: (error) => client.close(error),
        });
      } catch (error) {
        throw new Error(`Could not open ${path}: ${errorText(error)}`);
      }
      let id: string | null;
      try {
        id = await identify(client);
      } catch (error) {
        await transport.close();
        throw error;
      }
      if (id === FT710_ID) {
        this.lastGoodBaudRate = baudRate;
        return { transport, client };
      }
      await transport.close();
      if (id !== null) {
        throw new Error(
          `The radio on ${path} reports model ID ${id}, not the FT-710's ${FT710_ID}`,
        );
      }
    }
    const tried = rates.length === 1 ? ` at ${rates[0]} baud` : '';
    throw new Error(`No answer from the radio on ${path}${tried}. Is it switched on?`);
  }

  private update(patch: Patch): void {
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (this.state[key as keyof RadioState] !== value) changed[key] = value;
    }
    if (Object.keys(changed).length === 0) return;
    this.state = { ...this.state, ...changed };
    for (const listener of this.listeners) listener(this.state, changed);
  }
}
