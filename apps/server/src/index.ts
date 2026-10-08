import { networkInterfaces } from 'node:os';
import { SIM_PORT, loadConfig, type AudioConfig, type ScopeConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { loadCertificate } from './http/tls.ts';
import { Audio, SimulatedAudioDevice } from './radio/audio/audio.ts';
import { SdlAudioDevice } from './radio/audio/sdl.ts';
import { SimulatedTransport } from './radio/cat/simulator.ts';
import { Decoder } from './radio/digi/decoder.ts';
import { Ft8tsEngine } from './radio/digi/engine.ts';
import { Radio } from './radio/radio.ts';
import { Ft4222Source } from './radio/scope/ft4222.ts';
import { Scope } from './radio/scope/scope.ts';
import { SimulatedScopeSource } from './radio/scope/simulator.ts';

/** Addresses the interface can be opened at, for the startup banner. */
function listenUrls(scheme: string, host: string, port: number): string[] {
  if (host !== '0.0.0.0') return [`${scheme}://${host}:${port}`];
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === 'IPv4' && !address.internal)
    .map((address) => `${scheme}://${address?.address}:${port}`);
  return [`${scheme}://localhost:${port}`, ...lan];
}

function createScope(config: ScopeConfig, radio: Radio): Scope {
  switch (config.source) {
    case 'off':
      return new Scope(null);
    case 'sim':
      return new Scope(
        () =>
          new SimulatedScopeSource(() => {
            const state = radio.getState();
            return state.mainVfo === 'B' ? state.frequencyB : state.frequencyA;
          }),
      );
    case 'radio':
      return new Scope(() => new Ft4222Source(config.libraryPath));
  }
}

/** Microphone audio is passed on to the radio only where transmitting is allowed at all. */
function createAudio(config: AudioConfig, canTalk: boolean): Audio {
  switch (config.source) {
    case 'off':
      return new Audio(null);
    case 'sim':
      return new Audio(new SimulatedAudioDevice(), canTalk);
    case 'radio':
      return new Audio(new SdlAudioDevice(config.input, config.output), canTalk);
  }
}

/** Logs a line whenever it differs from the last one logged through the same function. */
function changeLogger(prefix: string): (line: string) => void {
  let last = '';
  return (line) => {
    if (line !== last) console.log(`[${prefix}] ${line}`);
    last = line;
  };
}

const config = loadConfig();
// One simulated radio for the life of the server, so that it stays off when switched off.
const simulator = new SimulatedTransport();
const radio = new Radio(config.cat, {
  txEnabled: config.txEnabled,
  ...(config.cat.port === SIM_PORT ? { createTransport: () => simulator } : {}),
});
const scope = createScope(config.scope, radio);
const audio = createAudio(config.audio, config.txEnabled);
// Decodes are labelled with what the radio was tuned to when their slot began.
const decoder = new Decoder(audio, new Ft8tsEngine(config.decodeDepth), {
  dial: () => {
    const state = radio.getState();
    return {
      hz: state.mainVfo === 'B' ? state.frequencyB : state.frequencyA,
      mode: state.modeMain,
    };
  },
});
if (config.txEnabled) console.log('[radio] transmit controls are enabled (RADIOBENCH_TX=on)');

const logRadio = changeLogger('radio');
radio.onState((state) => {
  // "connecting" recurs on every retry; only the outcome is worth a line.
  if (state.link === 'connecting') return;
  logRadio(
    state.link === 'connected' ? `connected on ${state.port}` : (state.linkError ?? 'disconnected'),
  );
});
const logScope = changeLogger('scope');
scope.onState((state) => logScope(state.detail ?? state.status));
const logAudio = changeLogger('audio');
audio.onState((state) => logAudio(state.detail ?? state.status));
const logDecoder = changeLogger('decoder');
decoder.onState((state) => logDecoder(state.detail ?? `${state.status} (${state.mode})`));

const webRoot = config.webRoot;
// Browsers hand the microphone only to pages served over HTTPS (or on localhost), so the same
// interface is also served over TLS, with a certificate the server makes for itself.
const certificate = config.https.enabled ? await loadCertificate(config.https.certDir) : null;
if (certificate?.created) {
  console.log(`[https] made a new certificate in ${config.https.certDir}: ${certificate.reason}`);
}
const app = await createHttpServer(radio, scope, audio, decoder, webRoot, {
  certificate: certificate?.cert,
});
try {
  await app.listen(config.http);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  console.error(
    `Port ${config.http.port} is in use by another program. ` +
      'Close that program, or set RADIOBENCH_HTTP_PORT to another port (see README.md).',
  );
  process.exit(1);
}
for (const url of listenUrls('http', config.http.host, config.http.port)) {
  console.log(`[http] ${url}`);
}

let secureApp: Awaited<ReturnType<typeof createHttpServer>> | null = null;
if (certificate) {
  secureApp = await createHttpServer(radio, scope, audio, decoder, webRoot, {
    https: { key: certificate.key, cert: certificate.cert },
    certificate: certificate.cert,
  });
  try {
    await secureApp.listen({ host: config.http.host, port: config.https.port });
    for (const url of listenUrls('https', config.http.host, config.https.port)) {
      console.log(`[https] ${url}`);
    }
    console.log(
      `[https] the certificate to trust is at ${listenUrls('http', config.http.host, config.http.port)[0]}/certificate`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    console.error(
      `[https] port ${config.https.port} is in use by another program; carrying on without HTTPS. ` +
        'Set RADIOBENCH_HTTPS_PORT to another port.',
    );
    secureApp = null;
  }
}

radio.start();
scope.start();

async function shutdown(): Promise<void> {
  decoder.stop();
  audio.stop();
  await Promise.all([radio.stop(), scope.stop()]);
  await Promise.all([app.close(), secureApp?.close()]);
  // The audio library keeps the process alive once it has been loaded.
  process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
// The desktop application runs the server as a child process. Windows has no signals to
// speak of, so it asks for a shutdown over the IPC channel instead.
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown();
});
