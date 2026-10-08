import { FT8DecoderPool, FT8History, HashCallBook, type DecodedMessage } from '@e04/ft8ts';
import { Worker } from 'node:worker_threads';
import { AUDIO_SAMPLE_RATE, type Decode, type DigiMode } from '@radiobench/protocol';
import type { DecodeEngine } from './decoder.ts';
import type { Ft4Reply, Ft4Request } from './ft4-worker.ts';

/** Decodes as WSJT-X reports them: whole dB, tenths of a second, whole Hz. */
function toDecode(message: DecodedMessage): Decode {
  return {
    snr: Math.round(message.snr),
    dt: Math.round(message.dt * 10) / 10,
    hz: Math.round(message.freq),
    text: message.msg,
    ...(message.ap === undefined ? {} : { ap: message.ap }),
  };
}

/**
 * FT8 and FT4 decoding with ft8ts, a port of WSJT-X's decoder. FT8 runs in ft8ts's own pool
 * of worker threads, one sub-band each; FT4 in a worker thread of ours. Either way the thread
 * that talks to the radio is never held up.
 */
export class Ft8tsEngine implements DecodeEngine {
  readonly depth: number;
  readonly threads: number;
  private readonly pool = new FT8DecoderPool();
  private readonly book = new HashCallBook();
  private readonly history = new FT8History();
  private ft4: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (decodes: Decode[]) => void; reject: (error: Error) => void }
  >();

  constructor(depth: number) {
    this.depth = depth;
    this.threads = this.pool.threads;
  }

  async decode(mode: DigiMode, samples: Float32Array, slotStart: number): Promise<Decode[]> {
    if (mode === 'FT4') return this.decodeFt4(samples);
    const decoded = await this.pool.decode(samples, {
      sampleRate: AUDIO_SAMPLE_RATE,
      depth: this.depth,
      hashCallBook: this.book,
      history: this.history,
      slotStart,
    });
    return decoded.map(toDecode);
  }

  private decodeFt4(samples: Float32Array): Promise<Decode[]> {
    const worker = this.ft4Worker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const request: Ft4Request = { id, samples, sampleRate: AUDIO_SAMPLE_RATE, depth: this.depth };
      worker.postMessage(request, [samples.buffer as ArrayBuffer]);
    });
  }

  private ft4Worker(): Worker {
    if (this.ft4) return this.ft4;
    // The worker is a module next to this one: TypeScript when run from the source tree,
    // JavaScript once compiled for distribution.
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`./ft4-worker.${extension}`, import.meta.url));
    worker.on('message', (reply: Ft4Reply) => {
      const pending = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      if (!pending) return;
      if ('error' in reply) pending.reject(new Error(reply.error));
      else pending.resolve(reply.decoded.map(toDecode));
    });
    worker.on('error', (error) => this.failAll(error));
    worker.on('exit', () => {
      this.ft4 = null;
      this.failAll(new Error('The FT4 decoding thread stopped'));
    });
    // The worker alone must not keep the server alive.
    worker.unref();
    this.ft4 = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }

  close(): void {
    this.pool.terminate();
    void this.ft4?.terminate();
    this.ft4 = null;
  }
}
