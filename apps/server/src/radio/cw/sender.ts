import { CW_MESSAGE_LENGTH, type CwSending } from '@radiobench/protocol';
import type { Radio } from '../radio.ts';
import { ditMs, keying } from './morse.ts';

/** How often the radio's state is looked at while a chunk is being keyed. */
const POLL_MS = 100;
/** The keyer's speed to assume when the radio has not said. */
const DEFAULT_WPM = 20;

type StateListener = (sending: CwSending | null) => void;

/**
 * Sends text in Morse with the radio's own keyer. The FT-710 keys from a PC only through its
 * CW memories, so the text goes into one of them, chunk by chunk, and is played from there;
 * whatever the owner kept in that memory is put back afterwards. The keyer alone only sounds
 * the sidetone, so the transmitter is keyed with MOX for as long as the text plays, unless the
 * sending is for practice.
 */
export class CwSender {
  private readonly radio: Radio;
  private readonly memory: number;
  private readonly listeners = new Set<StateListener>();
  private sending: CwSending | null = null;
  private stopped = false;

  /** memory is the CW memory, 1 to 5, used as the scratch slot. */
  constructor(radio: Radio, memory: number) {
    this.radio = radio;
    this.memory = memory;
  }

  getState(): CwSending | null {
    return this.sending;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends the text; resolves when it has been keyed, or stopped. */
  async send(text: string, practice = false): Promise<void> {
    if (this.sending) throw new Error('Morse is already being sent');
    const state = this.radio.getState();
    if (!state.modeMain?.startsWith('CW')) {
      throw new Error('Put the radio in a CW mode to send Morse');
    }
    const clean = text.toUpperCase().replace(/\s+/g, ' ').trim();
    const chunks = chunk(clean);
    this.stopped = false;
    this.update({ text: clean, sent: 0 });
    let keyed = false;
    try {
      // The owner's text in the scratch memory, to be put back.
      const original = (await this.radio.listMessages())[this.memory - 1] ?? '';
      let sent = 0;
      let last = original;
      for (const piece of chunks) {
        if (this.stopped) break;
        await this.radio.storeMessage(this.memory, piece);
        last = piece;
        // MOX before every chunk: the first keys the transmitter, the rest keep the server's
        // MOX watchdog from letting go of it during a long text.
        if (!practice) {
          await this.radio.set('mox', true);
          keyed = true;
        }
        await this.radio.playMessage(this.memory);
        await this.waitForKeying(piece);
        sent += piece.length + 1;
        this.update({ text: clean, sent: Math.min(sent, clean.length) });
      }
      if (original !== '' && original !== last)
        await this.radio.storeMessage(this.memory, original);
    } finally {
      if (keyed) await this.radio.set('mox', false).catch(() => undefined);
      this.update(null);
    }
  }

  /** Stops what is being sent; the radio stops keying at once and the transmitter is let go. */
  async stop(): Promise<void> {
    if (!this.sending) return;
    this.stopped = true;
    await this.radio.playMessage(0);
  }

  /** Waits as long as the keyer should take over a chunk, as the radio's state cannot tell. */
  private async waitForKeying(piece: string): Promise<void> {
    const dit = ditMs(this.radio.getState().keySpeed ?? DEFAULT_WPM);
    // The keyer ends a memory with a word space; a little slack covers the command itself.
    const dits = keying(piece).reduce((sum, element) => sum + element.dits, 0) + 7;
    const expected = dits * dit + 400;
    const started = Date.now();
    while (!this.stopped && Date.now() - started < expected) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private update(sending: CwSending | null): void {
    this.sending = sending;
    for (const listener of this.listeners) listener(sending);
  }
}

/** Cuts text into pieces a CW memory holds, at spaces where it can. */
export function chunk(text: string): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const word of text.split(' ')) {
    // A word longer than a memory is cut, like it or not.
    for (let at = 0; at < word.length; at += CW_MESSAGE_LENGTH) {
      const part = word.slice(at, at + CW_MESSAGE_LENGTH);
      if (piece === '') piece = part;
      else if (piece.length + 1 + part.length <= CW_MESSAGE_LENGTH) piece += ` ${part}`;
      else {
        pieces.push(piece);
        piece = part;
      }
    }
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}
