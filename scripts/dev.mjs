#!/usr/bin/env node
// Local dev server: builds once, serves ./dist on http://localhost:8080, rebuilds when src/,
// scripts/ or data/ change, and reloads open browser tabs after each rebuild.
//
//   npm run dev

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const port = Number(process.env.PORT) || 8080;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };
const RELOAD = `<script>new EventSource('/__reload').onmessage = () => location.reload();</script>`;

const clients = new Set();
let building = false, again = false;

function rebuild() {
  if (building) { again = true; return; }
  building = true;
  const t0 = Date.now();
  const p = spawn(process.execPath, [join(ROOT, 'scripts/build-site.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('exit', code => {
    building = false;
    console.log(code === 0 ? `rebuilt in ${Date.now() - t0} ms, reloading ${clients.size} tab(s)` : 'build failed');
    if (code === 0) for (const res of clients) res.write('data: reload\n\n');
    if (again) { again = false; rebuild(); }
  });
}

let timer;
const onChange = (_, file) => {
  if (file && /(^|[/\\])(\.|node_modules)|\.part$/.test(file)) return;
  clearTimeout(timer); timer = setTimeout(rebuild, 150);
};
for (const dir of ['src', 'scripts', 'data']) watch(join(ROOT, dir), { recursive: true }, onChange);

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  const file = join(DIST, path.endsWith('/') ? path + 'index.html' : path);
  try {
    let body = await readFile(file);
    if (file.endsWith('.html')) body = body.toString().replace('</body>', `${RELOAD}</body>`);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port} (watching src/, scripts/, data/)`));

rebuild();
