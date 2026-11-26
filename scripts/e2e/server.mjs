// One local server per test case: the production build in dist/ (prerendered pages, the SPA shell
// for anything else, trailing-slash redirects as vercel.json/the host config do) plus POST
// /api/chat answered by the REAL createChatHandler from api/lib/chat-handler.mjs with the fake
// model transport. A fresh handler per case keeps the per-worker and per-client counters isolated.
// Listens on loopback on a random free port.
//
// scripts/assistant-api.mjs is not reused: it builds its handler from process.env at import time
// with the real fetch, on a fixed port, and serves no pages.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createChatHandler } from '../../api/lib/chat-handler.mjs';
import { createFakeModel, requestScope } from './fake-model.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

// Model settings for the fake provider. The key values are dummies (the fake never checks them).
export const PROVIDER_ENV = {
  groq: { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'e2e-dummy-not-a-key', GROQ_MODEL: 'openai/gpt-oss-20b' },
  azure: { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: 'https://e2e-fake.openai.azure.com', AZURE_OPENAI_DEPLOYMENT: 'e2e-deployment', AZURE_OPENAI_API_KEY: 'e2e-dummy-not-a-key' },
};

const REPORTED_HEADERS = /^(retry-after|x-assistant-.*)$/i;

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

export async function startServer({ distDir, env, getScript, record = () => {} }) {
  const fetchImpl = createFakeModel({ getScript, record });
  const handler = createChatHandler({ env, fetchImpl });
  let apiRequests = 0;
  const root = path.resolve(distDir);

  async function api(req, res) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 32000) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Please shorten your message.' })); return; }
      chunks.push(chunk);
    }
    const n = ++apiRequests;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = null; }
    record({ stage: 'api-request', req: n, body });
    // Simulates the edge: it appends the visitor address and its own hop (see client-limit.mjs).
    const visitor = req.headers['x-e2e-client'] || req.socket.remoteAddress || '';
    const result = await requestScope.run({ req: n, attempt: 0 }, () => handler(body, { headers: { 'x-forwarded-for': `${visitor}, 10.255.0.1:443` } }));
    const reported = Object.fromEntries(Object.entries(result.headers ?? {}).filter(([name]) => REPORTED_HEADERS.test(name)));
    record({ stage: 'api-response', req: n, status: result.status, headers: reported, body: result.body });
    res.writeHead(result.status, result.headers);
    res.end(JSON.stringify(result.body));
  }

  async function page(req, res, url) {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }
    if (pathname.includes('..')) { res.writeHead(400); res.end(); return; }
    // Trailing-slash redirect for page URLs (vercel.json trailingSlash; Azure config does the same).
    if (!pathname.endsWith('/') && !path.extname(pathname)) { res.writeHead(308, { Location: `${pathname}/${url.search}` }); res.end(); return; }
    let file = path.join(root, pathname);
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!(await isFile(file))) file = path.extname(pathname) && !pathname.endsWith('/') ? null : path.join(root, 'app-shell.html');
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const work = url.pathname === '/api/chat'
      ? (req.method === 'POST' ? api(req, res) : Promise.resolve().then(() => { res.writeHead(405); res.end(); }))
      : page(req, res, url);
    work.catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    get apiRequests() { return apiRequests; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
