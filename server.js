/**
 * Divine Intelligence — Production Server v4
 *
 * Routes:
 *   GET  /                           → Serve app
 *   GET  /health                     → Status + DB check
 *
 *   Auth:
 *   GET  /auth/google                → Start Google OAuth flow
 *   GET  /auth/google/callback       → Complete Google OAuth, issue JWT
 *   GET  /auth/linkedin              → Start LinkedIn OAuth flow
 *   GET  /auth/linkedin/callback     → Complete LinkedIn OAuth, issue JWT
 *   POST /auth/email/register        → Email + password sign-up
 *   POST /auth/email/login           → Email + password sign-in
 *   GET  /api/me                     → Return current user (JWT required)
 *
 *   App:
 *   GET  /api/balance                → Fetch wallet balance
 *   POST /api/get-perspective        → Stream AI insight, deduct $0.05
 *   POST /api/top-up                 → Payment webhook (Stripe / Shift4)
 *   GET  /api/wallet/history         → Transaction history
 */

import 'dotenv/config';
import express            from 'express';
import { readFileSync }   from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import Anthropic          from '@anthropic-ai/sdk';
import jwt                from 'jsonwebtoken';
import bcrypt             from 'bcryptjs';
import pool, {
  getOrCreateWallet, deductCredit, creditWallet,
  getUserById, getUserByEmail,
  upsertGoogleUser, upsertLinkedInUser, createEmailUser,
} from './db.js';
import { getThinker } from './thinkers.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const app        = express();
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Constants ─────────────────────────────────────────────────────────────────
const INSIGHT_COST    = parseFloat(process.env.INSIGHT_COST    || '0.05');
const MAIN_MODEL      = process.env.ANTHROPIC_MODEL             || 'claude-sonnet-4-5';
const SUMMARY_MODEL   = 'claude-haiku-4-5';
const MAX_CTX_CHARS   = 12_000;
const PORT            = parseInt(process.env.PORT              || '3001');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const JWT_SECRET      = process.env.JWT_SECRET                  || 'divine-dev-secret-change-in-production';
const APP_URL         = process.env.APP_URL                     || 'https://divine.uncharted.ventures';

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI  = `${APP_URL}/auth/google/callback`;

const LINKEDIN_CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID     || '';
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || '';
const LINKEDIN_REDIRECT_URI  = `${APP_URL}/auth/linkedin/callback`;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api/top-up', express.raw({ type: '*/*' }));
app.use(express.json());

// ── JWT helper ────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, thinker_access: user.thinker_access },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/** Middleware: attach req.user if a valid Bearer token is present. Never blocks. */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  next();
}

/** Middleware: require valid JWT. */
function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    next();
  });
}

// ── Serve app ─────────────────────────────────────────────────────────────────
const HTML_FILE = join(__dirname, 'index.html');
app.get('/', (_req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readFileSync(HTML_FILE, 'utf8'));
  } catch {
    res.status(404).send('App not found.');
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', model: MAIN_MODEL, db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ── Google OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/google', (_req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).send('Google OAuth not configured.');
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth_error=no_code');

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

    // Get user info
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok) throw new Error('Could not fetch Google user info');

    const user = await upsertGoogleUser({
      googleId:  info.id,
      email:     info.email,
      name:      info.name,
      avatarUrl: info.picture,
    });

    const appToken = signToken(user);
    res.redirect(`/?token=${encodeURIComponent(appToken)}`);
  } catch (err) {
    console.error('[Google OAuth]', err.message);
    res.redirect('/?auth_error=google_failed');
  }
});

// ── LinkedIn OAuth ────────────────────────────────────────────────────────────
app.get('/auth/linkedin', (_req, res) => {
  if (!LINKEDIN_CLIENT_ID) return res.status(503).send('LinkedIn OAuth not configured.');
  const params = new URLSearchParams({
    client_id:     LINKEDIN_CLIENT_ID,
    redirect_uri:  LINKEDIN_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid profile email',
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth_error=no_code');

  try {
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
        redirect_uri:  LINKEDIN_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

    const infoRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok) throw new Error('Could not fetch LinkedIn user info');

    const user = await upsertLinkedInUser({
      linkedinId: info.sub,
      email:      info.email,
      name:       info.name,
      avatarUrl:  info.picture,
    });

    const appToken = signToken(user);
    res.redirect(`/?token=${encodeURIComponent(appToken)}`);
  } catch (err) {
    console.error('[LinkedIn OAuth]', err.message);
    res.redirect('/?auth_error=linkedin_failed');
  }
});

// ── Email auth ────────────────────────────────────────────────────────────────
app.post('/auth/email/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createEmailUser({ email, name: name || email.split('@')[0], passwordHash });
    res.json({ token: signToken(user), user });
  } catch (err) {
    console.error('[email register]', err.message);
    res.status(500).json({ error: 'Registration failed. Try again.' });
  }
});

app.post('/auth/email/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const user = await getUserByEmail(email);
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid email or password.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    const { password_hash, ...safe } = user;
    res.json({ token: signToken(safe), user: safe });
  } catch (err) {
    console.error('[email login]', err.message);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

// ── GET /api/me ───────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.sub);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  APP ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ── GET /api/balance ──────────────────────────────────────────────────────────
app.get('/api/balance', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required.' });

  try {
    const wallet = await getOrCreateWallet(userId);
    res.json({
      user_id:        wallet.user_id,
      credit_balance: parseFloat(wallet.credit_balance),
      insight_cost:   INSIGHT_COST,
      can_afford:     parseFloat(wallet.credit_balance) >= INSIGHT_COST,
    });
  } catch (err) {
    console.error('[/api/balance]', err.message);
    res.status(500).json({ error: 'Could not fetch balance. Try again.' });
  }
});

// ── GET /api/wallet/history ───────────────────────────────────────────────────
app.get('/api/wallet/history', async (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required.' });

  try {
    const { rows: walletRows } = await pool.query(
      'SELECT id FROM wallets WHERE user_id = $1', [userId]
    );
    if (!walletRows.length) return res.json([]);

    const { rows } = await pool.query(
      `SELECT type, amount, description, metadata, created_at
       FROM transactions WHERE wallet_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [walletRows[0].id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[wallet history]', err.message);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

// ── POST /api/get-perspective ─────────────────────────────────────────────────
app.post('/api/get-perspective', async (req, res) => {
  const { user_id, thinker_id, stage, decision, answers,
          messages: clientMessages, system: clientSystem } = req.body;

  if (!user_id)    return res.status(400).json({ error: 'user_id is required.'    });
  if (!thinker_id) return res.status(400).json({ error: 'thinker_id is required.' });
  if (!stage)      return res.status(400).json({ error: 'stage is required.'      });

  // Guest users have a localStorage-generated id like "u_<hex>" which is not a
  // valid Postgres UUID and has no row in the users table. We detect them here
  // and skip all wallet DB operations — they get free streaming access until
  // they sign in and a real wallet is provisioned.
  const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isGuest   = !UUID_RE.test(user_id);

  let wallet;
  if (isGuest) {
    wallet = { credit_balance: 99.00 }; // guest — no DB wallet, free access
  } else {
    try {
      wallet = await getOrCreateWallet(user_id);
    } catch (err) {
      return res.status(500).json({ error: 'Could not verify balance. Try again.' });
    }
  }

  if (!isGuest && parseFloat(wallet.credit_balance) < INSIGHT_COST) {
    return res.status(402).json({
      error:   'Your balance is empty. Top up to continue.',
      code:    'INSUFFICIENT_FUNDS',
      balance: parseFloat(wallet.credit_balance),
    });
  }

  const thinker = getThinker(thinker_id);
  if (!thinker) return res.status(404).json({ error: 'Thinker not found.' });

  let conversationHistory = [];
  let summaryPrefix       = '';

  try {
    const { rows } = await pool.query(
      `SELECT messages, summary, token_est FROM conversation_contexts
       WHERE user_id = $1 AND thinker_id = $2`,
      [user_id, thinker_id]
    );
    if (rows.length) {
      conversationHistory = rows[0].messages || [];
      summaryPrefix       = rows[0].summary  || '';
      const historyStr = JSON.stringify(conversationHistory);
      if (historyStr.length > MAX_CTX_CHARS) {
        const summaryRes = await anthropic.messages.create({
          model: SUMMARY_MODEL, max_tokens: 600,
          messages: [{ role: 'user', content: `Summarise this conversation in 3-5 bullet points:\n\n${historyStr}` }],
        });
        summaryPrefix       = summaryRes.content[0].text;
        conversationHistory = [];
      }
    }
  } catch (err) {
    console.error('[context load]', err.message);
  }

  // ── Build the messages array and system prompt for this stage ────────────
  let messages;
  let systemPrompt = thinker.systemPrompt;

  if (stage === 'chat') {
    // Conversational chat: client sends full message history + optional system override.
    // Use client messages directly; no JSON-output constraint.
    if (clientSystem) systemPrompt = clientSystem;
    if (!clientMessages?.length) {
      return res.status(400).json({ error: 'messages array is required for stage: chat' });
    }
    messages = clientMessages;

  } else {
    // Legacy structured stages (perspective flow)
    let userMessage = '';
    if (stage === 'questions') {
      userMessage = `Decision I'm working through: ${decision}\n\nGenerate 3 clarifying questions. Return exactly this JSON (no other text):\n[{"question":"..."},{"question":"..."},{"question":"..."}]`;
    } else if (stage === 'match') {
      const answersText = (answers || []).map((a, i) => `Q${i+1}: ${a.q}\nA: ${a.a}`).join('\n\n');
      userMessage = `Decision: ${decision}\n\nContext:\n${answersText}\n\nRate this founder's thinking. Return only JSON:\n{"score":85,"headline":"Strong alignment","sub":"2-4 words","reasoning":"2-3 sentences."}`;
    } else if (stage === 'reframe') {
      const answersText = (answers || []).map((a, i) => `Q${i+1}: ${a.q}\nA: ${a.a}`).join('\n\n');
      userMessage = `Decision: ${decision}\n\nContext:\n${answersText}\n\nApply your full framework. Return only JSON:\n{"keyInsight":{"title":"...","body":"..."},"frames":[{"icon":"🔍","label":"...","title":"...","body":"..."},{"icon":"⚡","label":"...","title":"...","body":"..."},{"icon":"🎯","label":"...","title":"...","body":"..."}]}`;
    } else {
      return res.status(400).json({ error: `Unknown stage: ${stage}` });
    }

    messages = [
      ...(summaryPrefix
        ? [{ role: 'user', content: `[Prior session summary]\n${summaryPrefix}` },
           { role: 'assistant', content: 'Understood. I have the context.' }]
        : []),
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let fullText = '';

  try {
    const stream = anthropic.messages.stream({
      model:      MAIN_MODEL,
      max_tokens: stage === 'chat' ? 2048 : 1024,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });

    stream.on('text', (text) => {
      fullText += text;
      res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    });

    const finalMsg = await stream.finalMessage();

    if (!isGuest) {
      try {
        await deductCredit(user_id, INSIGHT_COST, `${thinker.name} · ${stage}`, {
          thinker_id, stage,
          input_tokens:  finalMsg.usage?.input_tokens,
          output_tokens: finalMsg.usage?.output_tokens,
          cache_read:    finalMsg.usage?.cache_read_input_tokens,
          cache_write:   finalMsg.usage?.cache_creation_input_tokens,
        });
      } catch (deductErr) {
        console.error('[deduct]', deductErr.message);
      }
    }

    // Save conversation context for legacy stages only.
    // For 'chat', history is owned by the client (localStorage).
    if (!isGuest && stage !== 'chat') {
      const lastUserMsg = messages[messages.length - 1]?.content || '';
      const newHistory = [
        ...conversationHistory,
        { role: 'user',      content: lastUserMsg },
        { role: 'assistant', content: fullText    },
      ];
      await pool.query(
        `INSERT INTO conversation_contexts (user_id, thinker_id, messages, summary, token_est)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, thinker_id) DO UPDATE
           SET messages=$3, summary=$4, token_est=$5`,
        [user_id, thinker_id, JSON.stringify(newHistory), summaryPrefix,
         Math.ceil(JSON.stringify(newHistory).length / 4)]
      ).catch(err => console.error('[context save]', err.message));
    }

    const updated = isGuest ? null : await getOrCreateWallet(user_id).catch(() => null);
    res.write(`data: ${JSON.stringify({ type: 'done', balance: updated ? parseFloat(updated.credit_balance) : null })}\n\n`);
    res.end();

  } catch (err) {
    console.error('[stream error]', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong. Your balance has not been charged.' })}\n\n`);
    res.end();
  }
});

// ── POST /api/top-up ──────────────────────────────────────────────────────────
app.post('/api/top-up', async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload.' });
  }

  const handle = async (userId, credits, amountUsd, metadata) => {
    if (!userId || credits <= 0) return res.status(400).json({ error: 'Missing user_id or credits.' });
    const wallet = await creditWallet(userId, credits, `Top-up · $${amountUsd.toFixed(2)}`, metadata);
    res.json({ received: true, balance: parseFloat(wallet.credit_balance) });
  };

  try {
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data?.object;
      await handle(intent?.metadata?.user_id, parseFloat(intent?.metadata?.credits || '0'), (intent?.amount_received || 0) / 100, { payment_intent_id: intent?.id });
      return;
    }
    if (event.type === 'PAYMENT_UPDATED' && event.data?.status === 'SUCCESSFUL') {
      const p = event.data;
      await handle(p.metadata?.user_id, parseFloat(p.metadata?.credits || '0'), (p.amount || 0) / 100, { shift4_payment_id: p.id });
      return;
    }
    res.json({ received: true, ignored: true });
  } catch (err) {
    console.error('[top-up error]', err.message);
    res.status(500).json({ error: 'Could not credit wallet.' });
  }
});

// ── SPA catch-all ────────────────────────────────────────────────────────────
// Serve index.html for every non-API, non-auth route.
// This is what makes /dashboard/wallet work on browser refresh — the server
// returns the SPA shell and the client router takes over from there.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readFileSync(HTML_FILE, 'utf8'));
  } catch {
    res.status(404).send('App not found.');
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Divine Intelligence] Running on :${PORT}`);
  console.log(`  Model:         ${MAIN_MODEL}`);
  console.log(`  Insight cost:  $${INSIGHT_COST}`);
  console.log(`  Google OAuth:  ${GOOGLE_CLIENT_ID ? 'configured ✓' : 'NOT SET ⚠'}`);
  console.log(`  LinkedIn OAuth:${LINKEDIN_CLIENT_ID ? 'configured ✓' : ' NOT SET ⚠'}`);
  console.log(`  DB:            ${process.env.DATABASE_URL ? 'configured ✓' : 'NOT SET ⚠'}`);
});
