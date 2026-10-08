import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The simulated radio, worker threads and sound capture take their time on a shared CI
    // runner: a memory sweep or a band change can take over a second there.
    testTimeout: 20_000,
    expect: { poll: { timeout: 5_000 } },
  },
});
