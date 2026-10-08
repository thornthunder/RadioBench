import { setTimeout as sleep } from 'node:timers/promises';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sleeps, returning early once the signal aborts. */
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal }).catch(() => undefined);
}
