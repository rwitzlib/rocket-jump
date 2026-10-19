import { defineConfig } from 'vite';

// In development the page comes from Vite (port 5173, hot reload) and online play goes to the game
// server from `npm run dev:server` (port 8080), proxied so the page can use its own origin for both.
const GAME_SERVER = process.env.GAME_SERVER ?? 'localhost:8080';

export default defineConfig({
  // Rapier's compat build inlines its WASM, so the bundle is large by design.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  server: {
    open: false,
    proxy: {
      '/ws': { target: `ws://${GAME_SERVER}`, ws: true },
      '/status': { target: `http://${GAME_SERVER}` },
      '/rooms': { target: `http://${GAME_SERVER}` },
    },
  },
});
