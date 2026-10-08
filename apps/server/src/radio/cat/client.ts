import { CatError, CatTimeoutError } from './errors.ts';
import type { CatTransport } from './transport.ts';

/**
 * How long the radio is given to object to a set command. It answers "?;" to one it does not
 * accept and nothing otherwise, so silence for this long means the command took effect. It
 * doubles as the pause the radio is reported to need after being given something to do.
 */
export const SET_SETTLE_MS = 20;
const REPLY_TIMEOUT_MS = 500;

interface Pending {
  command: string;
  /** First two characters of the awaited reply; null when the command has none. */
  replyPrefix: string | null;
  resolve(reply: string | null): void;
  reject(error: Error): void;
}

/**
 * Speaks Yaesu CAT over a transport: ASCII commands ending in ";", strictly one at a time.
 * Read commands are answered at once (measured on an FT-710: within 40 ms at 9600 baud, with
 * no pause needed before the next one), so queries run back to back.
 */
export class CatClient {
  private readonly transport: CatTransport;
  private readonly onMessage: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  private buffer = '';
  private closedWith: Error | null = null;

  /** onMessage is given everything the radio says, whether or not it answers a query. */
  constructor(transport: CatTransport, onMessage: (message: string) => void = () => {}) {
    this.transport = transport;
    this.onMessage = onMessage;
  }

  /** Feeds characters received from the radio. */
  receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf(';');
      if (end < 0) break;
      const message = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.handle(message);
    }
  }

  /** Sends a read command such as "FA" and returns the reply without its ";". */
  async query(command: string): Promise<string> {
    const reply = await this.enqueue(() => this.exchange(command, command.slice(0, 2)));
    if (reply === null) throw new CatError(`No reply to ${command}`);
    return reply;
  }

  /** Sends a set command such as "FA014074000"; the radio only answers if it rejects it. */
  async set(command: string): Promise<void> {
    await this.enqueue(() => this.exchange(command, null));
  }

  /** Fails the command in flight and all later ones; call when the transport is gone. */
  close(error: Error): void {
    this.closedWith = error;
    this.pending?.reject(error);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private exchange(command: string, replyPrefix: string | null): Promise<string | null> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise<string | null>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.pending = null;
        settle();
      };
      const timer = setTimeout(
        () => finish(() => (replyPrefix ? reject(new CatTimeoutError(command)) : resolve(null))),
        replyPrefix ? REPLY_TIMEOUT_MS : SET_SETTLE_MS,
      );
      this.pending = {
        command,
        replyPrefix,
        resolve: (reply) => finish(() => resolve(reply)),
        reject: (error) => finish(() => reject(error)),
      };
      this.transport.write(`${command};`).catch((error: Error) => this.pending?.reject(error));
    });
  }

  private handle(message: string): void {
    const pending = this.pending;
    if (message === '?') {
      pending?.reject(new CatError(`The radio rejected the command ${pending.command}`));
      return;
    }
    this.onMessage(message);
    if (pending?.replyPrefix && message.startsWith(pending.replyPrefix)) pending.resolve(message);
  }
}
