import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import { AUTO_BAUD, SIM_PORT } from '../config.ts';
import { Audio } from '../radio/audio/audio.ts';
import { Decoder } from '../radio/digi/decoder.ts';
import { Radio } from '../radio/radio.ts';
import { Scope } from '../radio/scope/scope.ts';
import { createHttpServer } from './server.ts';
import { loadCertificate } from './tls.ts';

let dir: string;
let radio: Radio;
let app: FastifyInstance;
let port: number;
let cert: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'radiobench-https-'));
  const certificate = await loadCertificate(dir, { hosts: ['localhost'], ips: ['127.0.0.1'] });
  cert = certificate.cert;
  radio = new Radio({ port: SIM_PORT, baudRate: AUTO_BAUD, stopBits: 2 });
  const audio = new Audio(null);
  const decoder = new Decoder(
    audio,
    { depth: 1, threads: 1, decode: async () => [], close: () => {} },
    { dial: () => ({ hz: null, mode: null }) },
  );
  app = await createHttpServer(radio, new Scope(null), audio, decoder, 'no-web-client-here', {
    https: { key: certificate.key, cert: certificate.cert },
    certificate: certificate.cert,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  radio.start();
  await new Promise<void>((resolve) => {
    const stop = radio.onState((state) => {
      if (state.link !== 'connected') return;
      stop();
      resolve();
    });
  });
}, 30_000);

afterAll(async () => {
  await radio.stop();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A GET over TLS that trusts the server's own certificate. */
function get(path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    httpsRequest(
      { host: '127.0.0.1', port, path, ca: cert, servername: 'localhost' },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            type: String(response.headers['content-type']),
            body,
          }),
        );
      },
    )
      .on('error', reject)
      .end();
  });
}

test('serves the same interface over TLS, and offers its certificate for download', async () => {
  const state = await get('/api/state');
  expect(state.status).toBe(200);
  expect(JSON.parse(state.body)).toMatchObject({ link: 'connected', port: SIM_PORT });

  const download = await get('/certificate');
  expect(download.status).toBe(200);
  expect(download.type).toContain('x-x509-ca-cert');
  expect(download.body).toBe(cert);
});

test('the WebSocket works over TLS too', async () => {
  const socket = new WebSocket(`wss://localhost:${port}/ws`, { ca: cert });
  const first = await new Promise<string>((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
  });
  expect(JSON.parse(first)).toMatchObject({ type: 'state' });
  socket.close();
});
