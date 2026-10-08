import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, statSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'failed';

export interface ServerInfo {
  status: ServerStatus;
  /** The addresses the server said it listens on, as it printed them. */
  urls: { http: string[]; https: string[] };
  /** The last lines the server wrote, for showing why it failed. */
  recent: string[];
}

export interface ServerOptions {
  /** The Node.js executable; in Electron, its own one run as Node. */
  executable: string;
  /** The server's compiled entry point. */
  script: string;
  args: string[];
  env: Record<string, string>;
  logFile: string;
  onChange(info: ServerInfo): void;
}

/** The log is started afresh once it has grown past this. */
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;
const RECENT_LINES = 12;
/** How long the server gets to shut down tidily before it is killed. */
const SHUTDOWN_GRACE_MS = 4000;
/** Restart delays after the server stops on its own, growing with each failure in a row. */
const RESTART_DELAYS_MS = [2000, 5000, 15000, 60000];

/**
 * Runs the RadioBench server as a child process: starts it, keeps its output in a log,
 * restarts it when it stops unexpectedly, and shuts it down when asked.
 */
export class ServerProcess {
  private readonly options: ServerOptions;
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private info: ServerInfo = { status: 'stopped', urls: { http: [], https: [] }, recent: [] };
  private stopping = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  getInfo(): ServerInfo {
    return this.info;
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.openLog();
    this.update({ status: 'starting', urls: { http: [], https: [] }, recent: [] });
    this.write(`--- starting ${new Date().toISOString()}`);

    const child = spawn(this.options.executable, [this.options.script, ...this.options.args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.options.env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    let partial = '';
    const onData = (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) this.receive(line);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) =>
      this.receive(`[desktop] could not start the server: ${error.message}`),
    );
    child.on('exit', (code, signal) => {
      if (partial) this.receive(partial);
      this.child = null;
      this.write(`--- exited (${code ?? signal})`);
      if (this.stopping) {
        this.update({ ...this.info, status: 'stopped' });
        return;
      }
      // Stopped on its own: a failure, and a restart after a while.
      this.update({ ...this.info, status: 'failed' });
      const delay = RESTART_DELAYS_MS[Math.min(this.failures, RESTART_DELAYS_MS.length - 1)]!;
      this.failures++;
      this.restartTimer = setTimeout(() => this.start(), delay);
    });
  }

  /** Asks the server to shut down and waits for it; kills it if it takes too long. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.update({ ...this.info, status: 'stopped' });
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      child.send('shutdown');
    } catch {
      child.kill();
    }
    const timer = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  /** Stops the server and starts it again, with new settings when given. */
  async restart(env?: Record<string, string>): Promise<void> {
    await this.stop();
    if (env) this.options.env = env;
    this.failures = 0;
    this.start();
  }

  private receive(line: string): void {
    this.write(line);
    const recent = [...this.info.recent, line].slice(-RECENT_LINES);
    const urls = { http: [...this.info.urls.http], https: [...this.info.urls.https] };
    let status = this.info.status;
    const listening = /^\[(https?)\] (https?:\/\/\S+)$/.exec(line);
    if (listening) {
      urls[listening[1] as 'http' | 'https'].push(listening[2]!);
      status = 'running';
      this.failures = 0;
    }
    this.update({ status, urls, recent });
  }

  private openLog(): void {
    if (this.log) return;
    mkdirSync(dirname(this.options.logFile), { recursive: true });
    let size = 0;
    try {
      size = statSync(this.options.logFile).size;
    } catch {
      // No log yet.
    }
    this.log = createWriteStream(this.options.logFile, {
      flags: size > LOG_LIMIT_BYTES ? 'w' : 'a',
    });
  }

  private write(line: string): void {
    this.log?.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  }

  private update(info: ServerInfo): void {
    this.info = info;
    this.options.onChange(info);
  }
}
