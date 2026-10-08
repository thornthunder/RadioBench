import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import {
  RX_AUDIO_KIND,
  TX_AUDIO_KIND,
  WS_PATH,
  decodeAudio,
  encodeAudio,
  encodeMenuValue,
  encodeScopeFrame,
  findMenuItem,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@radiobench/protocol';
import fastify, { type FastifyInstance } from 'fastify';
import type { Audio } from '../radio/audio/audio.ts';
import type { Decoder } from '../radio/digi/decoder.ts';
import type { Radio } from '../radio/radio.ts';
import type { Scope } from '../radio/scope/scope.ts';
import { errorText } from '../util.ts';

/** Sweeps and audio are skipped for a client with this many bytes still waiting to be sent to it. */
const MAX_BUFFERED_BYTES = 256 * 1024;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/** Sends a binary frame unless the client is not keeping up: such data is only worth having fresh. */
function sendFresh(socket: WebSocket, packet: Uint8Array): void {
  if (socket.readyState === socket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES) {
    socket.send(packet);
  }
}

export interface ServerOptions {
  /** Serve over TLS with this key and certificate (PEM) instead of plain HTTP. */
  https?: { key: string; cert: string };
  /** The server's certificate (PEM), offered for download so that devices can trust it. */
  certificate?: string;
}

/**
 * Builds the HTTP server: the WebSocket that carries radio state, scope sweeps and audio out
 * and commands in, and the built web client from webRoot when it exists. One is built for
 * plain HTTP and, where wanted, another for HTTPS; both serve the same radio.
 */
export async function createHttpServer(
  radio: Radio,
  scope: Scope,
  audio: Audio,
  decoder: Decoder,
  webRoot: string,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  // The two kinds of instance differ only in their server type, which nothing here looks at.
  const app: FastifyInstance = options.https
    ? (fastify({ https: options.https }) as unknown as FastifyInstance)
    : fastify();
  await app.register(fastifyWebsocket);

  const sockets = new Set<WebSocket>();
  // The client that switched MOX on. Should it vanish, nobody is left to switch MOX off again.
  let moxHolder: WebSocket | null = null;

  const broadcast = (message: ServerMessage) => {
    for (const socket of sockets) send(socket, message);
  };

  radio.onState((_state, patch) => {
    if (patch.mox === false) moxHolder = null;
    broadcast({ type: 'patch', patch });
  });
  radio.onMenu((id, raw) => broadcast({ type: 'menu', values: { [id]: raw } }));
  scope.onState((state) => broadcast({ type: 'scope', scope: state }));
  audio.onState((state) => broadcast({ type: 'audio', audio: state }));
  decoder.onState((state) => broadcast({ type: 'decoder', decoder: state }));
  // Decodes are small and go to everyone; a client that has not asked ignores them.
  decoder.onBatch((batch) => broadcast({ type: 'decodes', batches: [batch] }));
  scope.onFrame((frame) => {
    const packet = encodeScopeFrame(frame);
    for (const socket of sockets) sendFresh(socket, packet);
  });

  // Memories and messages are read when asked for and after each change, and go to everyone.
  const sendMemories = async () =>
    broadcast({ type: 'memories', channels: await radio.listMemories() });
  const sendMessages = async () =>
    broadcast({ type: 'messages', texts: await radio.listMessages() });

  /** Carries out a client's command. What it changes comes back to the clients as state. */
  async function execute(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'set':
        return radio.set(message.key, message.value as never);
      case 'action':
        return radio.act(message.action, message.value);
      case 'menuRead':
        return radio.readMenu(message.ids);
      case 'menuSet': {
        const item = findMenuItem(message.id);
        const raw = item ? encodeMenuValue(item, message.value) : null;
        if (raw === null) throw new Error('That is not a value the menu item takes');
        return radio.setMenu(message.id, raw);
      }
      case 'memoryList':
        return sendMemories();
      case 'memoryRecall':
        return radio.recallMemory(message.channel);
      case 'memoryStore':
        await radio.storeMemory(message.channel);
        return sendMemories();
      case 'memoryTag':
        await radio.tagMemory(message.channel, message.tag);
        return sendMemories();
      case 'messageList':
        return sendMessages();
      case 'messageStore':
        await radio.storeMessage(message.number, message.text);
        return sendMessages();
      case 'messagePlay':
        return radio.playMessage(message.number);
      case 'voicePlay':
        return radio.playVoice(message.number);
      case 'record':
        return radio.record(message.on);
      case 'power':
        return radio.power(message.on);
      case 'listen':
      case 'decode':
        // Handled where the socket is known.
        return;
    }
  }

  app.get('/api/state', () => radio.getState());
  app.get('/api/scope', () => scope.getState());
  app.get('/api/audio', () => audio.getState());
  app.get('/api/decoder', () => ({ ...decoder.getState(), recent: decoder.recent() }));
  if (options.certificate) {
    const certificate = options.certificate;
    app.get('/certificate', (_request, reply) => {
      reply
        .type('application/x-x509-ca-cert')
        .header('Content-Disposition', 'attachment; filename="radiobench.crt"')
        .send(certificate);
    });
  }

  app.get(WS_PATH, { websocket: true }, (socket) => {
    sockets.add(socket);
    let stopListening: (() => void) | null = null;
    let stopDecoding: (() => void) | null = null;

    socket.on('close', () => {
      sockets.delete(socket);
      stopListening?.();
      stopDecoding?.();
      if (moxHolder === socket) {
        moxHolder = null;
        radio.set('mox', false).catch(() => undefined);
      }
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        // The only binary frames a client sends are its microphone audio.
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
        const samples = decodeAudio(TX_AUDIO_KIND, bytes);
        if (samples) audio.talk(samples);
        return;
      }
      const message = parseClientMessage(raw.toString());
      if (!message) {
        send(socket, { type: 'error', message: 'Unrecognised command' });
        return;
      }
      if (message.type === 'listen') {
        stopListening?.();
        stopListening = message.on
          ? audio.listen((samples) => sendFresh(socket, encodeAudio(RX_AUDIO_KIND, samples)))
          : null;
        return;
      }
      if (message.type === 'decode') {
        if (message.mode) decoder.setMode(message.mode);
        stopDecoding?.();
        stopDecoding = message.on ? decoder.use() : null;
        // What was decoded before this client asked, so that its list does not start empty.
        if (message.on) send(socket, { type: 'decodes', batches: decoder.recent() });
        return;
      }
      execute(message).then(
        () => {
          if (message.type === 'set' && message.key === 'mox' && message.value === true) {
            moxHolder = socket;
          }
        },
        (error: unknown) => send(socket, { type: 'error', message: errorText(error) }),
      );
    });

    send(socket, { type: 'state', state: radio.getState() });
    send(socket, { type: 'scope', scope: scope.getState() });
    send(socket, { type: 'audio', audio: audio.getState() });
    send(socket, { type: 'decoder', decoder: decoder.getState() });
  });

  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot });
  } else {
    app.get('/', (_request, reply) => {
      reply
        .type('text/plain')
        .send('The web client has not been built. Run "npm run build", or use "npm run dev".\n');
    });
  }

  return app;
}
