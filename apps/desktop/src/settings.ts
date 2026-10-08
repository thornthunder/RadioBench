import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What the desktop application lets the user change about the server, kept as JSON in the
 * application's data folder. Each maps to one of the server's RADIOBENCH_* settings.
 */
export interface Settings {
  /** "auto", "sim", or a serial port name such as "COM3". */
  catPort: string;
  /** "auto" or a baud rate. */
  catBaud: string;
  httpPort: number;
  httpsPort: number;
  /** Whether browsers may key the transmitter (RADIOBENCH_TX). */
  allowTransmit: boolean;
  scope: boolean;
  audio: boolean;
  /** FT8/FT4 decoding depth, 1 to 3. */
  decodeDepth: number;
  /** Whether RadioBench starts when the user logs on to Windows. */
  openAtLogin: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  catPort: 'auto',
  catBaud: 'auto',
  httpPort: 81,
  httpsPort: 444,
  allowTransmit: false,
  scope: true,
  audio: true,
  decodeDepth: 3,
  openAtLogin: false,
};

/** Reads the settings file; missing or malformed values fall back to the defaults. */
export function loadSettings(file: string): Settings {
  let raw: unknown = {};
  try {
    // Notepad and PowerShell like to start a UTF-8 file with a byte order mark; JSON does not.
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    // No file yet, or not JSON: the defaults it is.
  }
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const chosen: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = given[key];
    if (value !== undefined && typeof value === typeof chosen[key]) chosen[key] = value;
  }
  const settings = chosen as unknown as Settings;
  if (!Number.isInteger(settings.httpPort) || settings.httpPort < 1 || settings.httpPort > 65535) {
    settings.httpPort = DEFAULT_SETTINGS.httpPort;
  }
  if (
    !Number.isInteger(settings.httpsPort) ||
    settings.httpsPort < 1 ||
    settings.httpsPort > 65535
  ) {
    settings.httpsPort = DEFAULT_SETTINGS.httpsPort;
  }
  if (![1, 2, 3].includes(settings.decodeDepth))
    settings.decodeDepth = DEFAULT_SETTINGS.decodeDepth;
  return settings;
}

export function saveSettings(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/** Where the server finds its files when run by the desktop application. */
export interface ServerPaths {
  webRoot: string;
  certDir: string;
  ft4222Dll: string;
}

/** The server's environment for the given settings. */
export function serverEnvironment(settings: Settings, paths: ServerPaths): Record<string, string> {
  return {
    RADIOBENCH_CAT_PORT: settings.catPort,
    RADIOBENCH_CAT_BAUD: settings.catBaud,
    RADIOBENCH_HTTP_PORT: String(settings.httpPort),
    RADIOBENCH_HTTPS: 'on',
    RADIOBENCH_HTTPS_PORT: String(settings.httpsPort),
    RADIOBENCH_TX: settings.allowTransmit ? 'on' : 'off',
    RADIOBENCH_SCOPE: settings.scope ? 'on' : 'off',
    RADIOBENCH_AUDIO: settings.audio ? 'on' : 'off',
    RADIOBENCH_DECODE_DEPTH: String(settings.decodeDepth),
    RADIOBENCH_WEB_ROOT: paths.webRoot,
    RADIOBENCH_CERT_DIR: paths.certDir,
    RADIOBENCH_FT4222_DLL: paths.ft4222Dll,
  };
}
