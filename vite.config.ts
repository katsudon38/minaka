import type { Server } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import { attachRelay } from './server/relay';

/** 開発サーバー・プレビューでも同じポートで中継サーバーを動かす */
function relay(): Plugin {
  return {
    name: 'minaka-relay',
    configureServer(server) {
      if (server.httpServer) attachRelay(server.httpServer as Server);
    },
    configurePreviewServer(server) {
      attachRelay(server.httpServer as Server);
    },
  };
}

export default defineConfig({
  base: './',
  server: { host: true },
  preview: { host: true },
  plugins: [relay()],
  // three.js 本体で 700kB 前後になるため
  build: { chunkSizeWarningLimit: 900 },
});
