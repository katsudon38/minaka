import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  // three.js 本体で 700kB 前後になるため
  build: { chunkSizeWarningLimit: 900 },
});
