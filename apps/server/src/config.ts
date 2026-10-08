import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_HTTP_PORT, DIGI_DEPTHS } from '@radiobench/protocol';

/** CAT port value that selects the built-in simulator instead of a serial port. */
export const SIM_PORT = 'sim';
/** CAT port value that makes the server look for the FT-710's CAT port itself. */
export const AUTO_PORT = 'auto';
/** CAT baud value that makes the server try each rate the radio offers. */
export const AUTO_BAUD = 'auto';

export interface CatConfig {
  /** AUTO_PORT, SIM_PORT, or a serial port name such as "COM3". */
  port: string;
  baudRate: number | typeof AUTO_BAUD;
  stopBits: 1 | 2;
}

export interface ScopeConfig {
  /** "radio" reads the FT-710's scope port, "sim" makes up a spectrum, "off" disables the scope. */
  source: 'radio' | 'sim' | 'off';
  /** Where FTDI's LibFT4222-64.dll is; only needed for "radio". */
  libraryPath: string;
}

export interface AudioConfig {
  /** "radio" uses the FT-710's USB sound device, "sim" makes up audio, "off" disables audio. */
  source: 'radio' | 'sim' | 'off';
  /** Part of the name of the recording device that carries the radio's received audio. */
  input: string;
  /** Part of the name of the playback device that feeds the radio's transmit audio. */
  output: string;
}

export interface HttpsConfig {
  /** Whether to serve over HTTPS as well; browsers need that to allow the microphone. */
  enabled: boolean;
  port: number;
  /** Where the server keeps the certificate it makes for itself. */
  certDir: string;
}

export interface Config {
  http: { host: string; port: number };
  https: HttpsConfig;
  /** Where the built web client is; the server serves it when it exists. */
  webRoot: string;
  cat: CatConfig;
  scope: ScopeConfig;
  audio: AudioConfig;
  /** How hard the FT8/FT4 decoder tries, as WSJT-X's 1 (fast), 2 (normal) or 3 (deep). */
  decodeDepth: number;
  /** Whether clients may key the transmitter: MOX, VOX and antenna tuning. */
  txEnabled: boolean;
}

function switchSetting(env: NodeJS.ProcessEnv, name: string, fallback: 'on' | 'off'): boolean {
  const value = env[name] || fallback;
  if (value !== 'on' && value !== 'off') {
    throw new Error(`${name} must be "on" or "off", got "${value}"`);
  }
  return value === 'on';
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

/** Reads settings from RADIOBENCH_* environment variables; see .env.example. */
export function loadConfig(argv = process.argv.slice(2), env = process.env): Config {
  const { values } = parseArgs({ args: argv, options: { sim: { type: 'boolean' } } });
  const stopBits = integer(env, 'RADIOBENCH_CAT_STOP_BITS', 2);
  if (stopBits !== 1 && stopBits !== 2) {
    throw new Error(`RADIOBENCH_CAT_STOP_BITS must be 1 or 2, got "${stopBits}"`);
  }
  const baud = env.RADIOBENCH_CAT_BAUD || AUTO_BAUD;
  const port = values.sim ? SIM_PORT : env.RADIOBENCH_CAT_PORT || AUTO_PORT;
  const scope = switchSetting(env, 'RADIOBENCH_SCOPE', 'on');
  const audio = switchSetting(env, 'RADIOBENCH_AUDIO', 'on');
  const decodeDepth = integer(env, 'RADIOBENCH_DECODE_DEPTH', 3);
  if (!(DIGI_DEPTHS as readonly number[]).includes(decodeDepth)) {
    throw new Error(`RADIOBENCH_DECODE_DEPTH must be 1, 2 or 3, got "${decodeDepth}"`);
  }
  return {
    decodeDepth,
    webRoot: env.RADIOBENCH_WEB_ROOT || fileURLToPath(new URL('../../web/dist', import.meta.url)),
    audio: {
      source: !audio ? 'off' : port === SIM_PORT ? 'sim' : 'radio',
      // Windows lists the radio's sound device as "USB Audio Device", for both directions.
      input: env.RADIOBENCH_AUDIO_IN || 'USB Audio Device',
      output: env.RADIOBENCH_AUDIO_OUT || 'USB Audio Device',
    },
    txEnabled: switchSetting(env, 'RADIOBENCH_TX', 'off'),
    http: {
      host: env.RADIOBENCH_HTTP_HOST || '0.0.0.0',
      port: integer(env, 'RADIOBENCH_HTTP_PORT', DEFAULT_HTTP_PORT),
    },
    https: {
      enabled: switchSetting(env, 'RADIOBENCH_HTTPS', 'on'),
      // 443 is taken by Windows itself on some PCs; 444 is the next one down from 1024 that is
      // free of the ports Windows hands out for outgoing connections.
      port: integer(env, 'RADIOBENCH_HTTPS_PORT', 444),
      certDir: env.RADIOBENCH_CERT_DIR || fileURLToPath(new URL('../certs', import.meta.url)),
    },
    cat: {
      port,
      baudRate: baud === AUTO_BAUD ? AUTO_BAUD : integer(env, 'RADIOBENCH_CAT_BAUD', 0),
      stopBits,
    },
    scope: {
      // A simulated radio gets a simulated scope to match.
      source: !scope ? 'off' : port === SIM_PORT ? 'sim' : 'radio',
      libraryPath:
        env.RADIOBENCH_FT4222_DLL ||
        fileURLToPath(new URL('../vendor/LibFT4222-64.dll', import.meta.url)),
    },
  };
}
