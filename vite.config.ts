import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset URLs: the game is served under a path (games.noblehaus.uk/oathbound/)
  base: './',
  // `npm run server` runs the game server on :3011; the dev server forwards /ws to it
  server: { port: 5173, host: '127.0.0.1', proxy: { '/ws': { target: 'ws://127.0.0.1:3011', ws: true } } },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, rollupOptions: { input: { main: 'index.html', renderTest: 'render-test.html' } } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
