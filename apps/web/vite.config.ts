import { DEFAULT_HTTP_PORT, WS_PATH } from '@radiobench/protocol';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the page comes from Vite, while the API and WebSocket are
// forwarded to the RadioBench server running alongside it.
const server = `http://localhost:${DEFAULT_HTTP_PORT}`;

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so that the page also works behind a reverse proxy that puts it
  // under a path such as /ft710/.
  base: './',
  server: {
    host: true,
    proxy: {
      '/api': server,
      [WS_PATH]: { target: server, ws: true },
    },
  },
});
