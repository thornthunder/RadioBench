import type { ScopeFrame, ScopeState } from '@radiobench/protocol';
import { errorText, pause } from '../../util.ts';
import { readFrames } from './reader.ts';
import type { ScopeSource } from './source.ts';

const RETRY_DELAY_MS = 2000;

type FrameListener = (frame: ScopeFrame) => void;
type StateListener = (state: ScopeState) => void;

function sameBins(a: Uint8Array, b: Uint8Array): boolean {
  return a.every((value, i) => value === b[i]);
}

/**
 * Keeps the radio's spectrum scope flowing: opens the scope port, hands each new sweep to the
 * listeners, and reopens the port whenever the stream fails. Without a source it stays off.
 */
export class Scope {
  private readonly createSource: (() => ScopeSource) | null;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly stateListeners = new Set<StateListener>();
  private state: ScopeState;
  private abort: AbortController | null = null;
  private finished: Promise<void> = Promise.resolve();

  constructor(createSource: (() => ScopeSource) | null) {
    this.createSource = createSource;
    this.state = createSource
      ? { status: 'unavailable', detail: 'Starting' }
      : { status: 'off', detail: null };
  }

  getState(): ScopeState {
    return this.state;
  }

  /** Calls the listener with every new sweep; returns a function that unsubscribes it. */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Calls the listener on every state change; returns a function that unsubscribes it. */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  start(): void {
    if (this.abort || !this.createSource) return;
    this.abort = new AbortController();
    this.finished = this.run(this.createSource, this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.finished;
    this.abort = null;
  }

  private async run(createSource: () => ScopeSource, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const source = createSource();
      try {
        await source.open();
        await this.stream(source, signal);
      } catch (error) {
        this.update({ status: 'unavailable', detail: errorText(error) });
      } finally {
        await source.close().catch(() => undefined);
      }
      await pause(RETRY_DELAY_MS, signal);
    }
    this.update({ status: 'unavailable', detail: 'Stopped' });
  }

  private async stream(source: ScopeSource, signal: AbortSignal): Promise<void> {
    let previous: Uint8Array | null = null;
    for await (const frame of readFrames(source, signal)) {
      this.update({ status: 'running', detail: null });
      // The port is read faster than the radio sweeps, so some reads repeat the last sweep.
      if (previous && sameBins(frame.bins, previous)) continue;
      previous = frame.bins;
      for (const listener of this.frameListeners) listener(frame);
    }
  }

  private update(next: ScopeState): void {
    if (next.status === this.state.status && next.detail === this.state.detail) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}
