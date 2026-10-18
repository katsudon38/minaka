// 本番用サーバー：ビルド済みのゲーム（dist/）を配信し、同じポートで中継サーバーを動かす。
// 使い方: npm run build && npm run serve   （PORT で待ち受けポートを変更）

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { attachRelay } from './relay';

const root = resolve(import.meta.dirname, '../dist');
const port = Number(process.env.PORT ?? 8080);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

if (!existsSync(join(root, 'index.html'))) {
  console.error('dist/ がありません。先に npm run build を実行してください。');
  process.exit(1);
}

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${join(root, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
});

attachRelay(server);
server.listen(port, () => console.log(`ミナカ島戦記: http://localhost:${port}`));
