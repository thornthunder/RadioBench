// Decodes FT4 slots on a thread of their own, for Ft8tsEngine. ft8ts decodes FT4 on the
// calling thread, and half a second of that would hold up the CAT loop.
import { HashCallBook, decodeFT4, type DecodedFT4Message } from '@e04/ft8ts';
import { parentPort } from 'node:worker_threads';

export interface Ft4Request {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  depth: number;
}

export type Ft4Reply = { id: number; decoded: DecodedFT4Message[] } | { id: number; error: string };

// Callsigns heard in full are remembered, so that their hashed forms can be read later.
const book = new HashCallBook();

parentPort?.on('message', (request: Ft4Request) => {
  let reply: Ft4Reply;
  try {
    const decoded = decodeFT4(request.samples, {
      sampleRate: request.sampleRate,
      depth: request.depth,
      hashCallBook: book,
    });
    reply = { id: request.id, decoded };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort?.postMessage(reply);
});
