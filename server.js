/**
 * Divine Intelligence — Production Server
 *
 * Does two things:
 *   1. Serves the app HTML at GET /
 *   2. Proxies Anthropic API calls at POST /api/chat
 *
 * Deploy: Railway / Render / Fly.io
 *   → Set ANTHROPIC_API_KEY as an environment variable
 *   → Everything else just works
 *
 * Local dev:
 *   cp .env.example .env
 *   node server.js
 */

import { createServer }           from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname }          from 'path';
import { fileURLToPath }          from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── Load .env (local dev only — production uses platform env vars) ── */
try {
  const env = readFileSync(join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* no .env in production — that's fine */ }

const PORT  = process.env.PORT  || 3001;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';

/* ── CORS (lock to your domain in production) ── */
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

function corsHeaders(req) {
  const origin = req.headers.origin || '*';
  const allow  = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/* ── Helpers ── */
function send(res, status, data, extraHeaders = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const ct   = typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json';
  res.writeHead(status, { 'Content-Type': ct, ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end',  () => { try { ok(JSON.parse(buf)); } catch { fail(new Error('Invalid JSON')); } });
    req.on('error', fail);
  });
}

/* ── HTML file (served from same directory as server.js) ── */
const HTML_FILE = join(__dirname, 'index.html');

/* ── Server ── */
const server = createServer(async (req, res) => {
  const url     = new URL(req.url, `http://localhost:${PORT}`);
  const cors    = corsHeaders(req);

  /* Pre-flight */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  /* ── GET / → serve the app ── */
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!existsSync(HTML_FILE)) return send(res, 404, 'App HTML not found.', cors);
    const html = readFileSync(HTML_FILE, 'utf8');
    return send(res, 200, html, cors);
  }

  /* ── GET /health ── */
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { status: 'ok', model: MODEL }, cors);
  }

  /* ── POST /api/chat → Anthropic proxy ── */
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return send(res, 500, { error: 'ANTHROPIC_API_KEY not configured on server.' }, cors);

    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }, cors); }

    const { system, user, max_tokens = 1024, model } = body;
    if (!system || !user) return send(res, 400, { error: '"system" and "user" are required.' }, cors);

    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'x-api-key':         key,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:     model || MODEL,
          max_tokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        console.error('[Anthropic error]', upstream.status, err);
        return send(res, upstream.status, { error: err }, cors);
      }

      const data = await upstream.json();
      return send(res, 200, { text: data.content[0].text }, cors);

    } catch (err) {
      console.error('[Proxy error]', err.message);
      return send(res, 500, { error: err.message }, cors);
    }
  }

  /* ── 404 ── */
  send(res, 404, { error: 'Not found' }, cors);
});

server.listen(PORT, () => {
  console.log(`\n✦ Divine Intelligence`);
  console.log(`  App:     http://localhost:${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  Model:   ${MODEL}`);
  console.log(`  Key:     ${process.env.ANTHROPIC_API_KEY ? '✓ loaded' : '✗ missing — set ANTHROPIC_API_KEY'}\n`);
});
