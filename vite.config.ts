import { defineConfig } from 'vite';

export default defineConfig({
  // Rapier's compat build inlines its WASM, so the bundle is large by design.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  server: { open: false },
});
