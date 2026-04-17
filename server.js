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
import Stripe             from 'stripe';
import jwt                from 'jsonwebtoken';
import bcrypt             from 'bcryptjs';
import pool, {
  getOrCreateWallet, deductCredit, creditWallet,
  getUserById, getUserByEmail, getUserByIdRaw,
  upsertGoogleUser, upsertLinkedInUser, createEmailUser,
  updateUserName, updateUserEmail, updateUserPassword,
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

// ── Stripe ────────────────────────────────────────────────────────────────────
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET  || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

// ── Guest rate-limit constants ────────────────────────────────────────────────
const GUEST_LIMIT  = parseInt(process.env.GUEST_RATE_LIMIT || '3');
const GUEST_WINDOW = (parseInt(process.env.GUEST_RATE_WINDOW_HOURS || '72')) * 60 * 60 * 1000;

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

// ── Guest rate-limit helpers ──────────────────────────────────────────────────
import { createHash } from 'node:crypto';

/**
 * Hash the client IP into a short token for secondary rate limiting.
 * We never store the raw IP.
 */
function hashIp(req) {
  const raw = req.headers['x-forwarded-for']?.split(',')[0].trim()
           || req.socket?.remoteAddress
           || '';
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Returns { limited, count, resetsAt } for a guest user.
 * If the DB is unavailable we return { limited: false } to avoid blocking
 * legitimate users due to an infrastructure issue.
 */
async function checkGuestRateLimit(guestId, ipHash) {
  try {
    const windowStart = new Date(Date.now() - GUEST_WINDOW).toISOString();

    // Primary check: by guest_id
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest
       FROM guest_rate_limits
       WHERE guest_id = $1 AND created_at > $2`,
      [guestId, windowStart]
    );
    const countById = parseInt(rows[0].cnt, 10);

    if (countById >= GUEST_LIMIT) {
      const resetsAt = rows[0].oldest
        ? new Date(new Date(rows[0].oldest).getTime() + GUEST_WINDOW).toISOString()
        : null;
      return { limited: true, count: countById, resetsAt };
    }

    // Secondary check: by IP hash — catch users who cleared localStorage
    if (ipHash) {
      const { rows: ipRows } = await pool.query(
        `SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest
         FROM guest_rate_limits
         WHERE ip_hash = $1 AND created_at > $2`,
        [ipHash, windowStart]
      );
      const countByIp = parseInt(ipRows[0].cnt, 10);

      if (countByIp >= GUEST_LIMIT) {
        const resetsAt = ipRows[0].oldest
          ? new Date(new Date(ipRows[0].oldest).getTime() + GUEST_WINDOW).toISOString()
          : null;
        return { limited: true, count: countByIp, resetsAt };
      }
    }

    return { limited: false, count: countById };
  } catch (err) {
    console.error('[guest rate-limit check]', err.message);
    return { limited: false, count: 0 }; // fail open
  }
}

/**
 * Record one guest usage event. Called after a successful stream completes.
 */
async function recordGuestUsage(guestId, ipHash) {
  try {
    await pool.query(
      `INSERT INTO guest_rate_limits (guest_id, ip_hash) VALUES ($1, $2)`,
      [guestId, ipHash]
    );
  } catch (err) {
    console.error('[guest rate-limit record]', err.message);
  }
}

// ── Serve app ─────────────────────────────────────────────────────────────────
const HTML_FILE = join(__dirname, 'index.html');
app.get('/', (_req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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

// ── PATCH /api/me ─────────────────────────────────────────────────────────────
// Update display name
app.patch('/api/me', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  try {
    const user = await updateUserName(req.user.sub, name.trim());
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/me/email ───────────────────────────────────────────────────────
// Change email — requires current password confirmation
app.patch('/api/me/email', requireAuth, async (req, res) => {
  const { newEmail, password } = req.body || {};
  if (!newEmail || !password) return res.status(400).json({ error: 'New email and current password are required.' });

  try {
    const raw = await getUserByIdRaw(req.user.sub);
    if (!raw) return res.status(404).json({ error: 'User not found.' });
    if (!raw.password_hash) return res.status(400).json({ error: 'Password change is not available for OAuth accounts.' });
    const match = await bcrypt.compare(password, raw.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    // Check new email not already taken
    const existing = await getUserByEmail(newEmail);
    if (existing && existing.id !== req.user.sub) return res.status(409).json({ error: 'That email is already in use.' });

    const user = await updateUserEmail(req.user.sub, newEmail);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/me/password ────────────────────────────────────────────────────
// Change password — requires current password confirmation
app.patch('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new passwords are required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  try {
    const raw = await getUserByIdRaw(req.user.sub);
    if (!raw) return res.status(404).json({ error: 'User not found.' });
    if (!raw.password_hash) return res.status(400).json({ error: 'Password change is not available for OAuth accounts.' });
    const match = await bcrypt.compare(currentPassword, raw.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await updateUserPassword(req.user.sub, hash);
    res.json({ ok: true });
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
      `SELECT line_item_type, amount, direction, label, balance_after, created_at
       FROM wallet_transactions WHERE wallet_id = $1
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
  // and apply server-side rate limiting (3 perspectives / 72h), then skip all
  // wallet DB operations for the session.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isGuest = !UUID_RE.test(user_id);
  const ipHash  = hashIp(req);

  let wallet;
  if (isGuest) {
    // ── Server-side rate limit for guests ──────────────────────────────────
    const rl = await checkGuestRateLimit(user_id, ipHash);
    if (rl.limited) {
      return res.status(429).json({
        error:     'Free perspective limit reached. Sign up to continue.',
        code:      'RATE_LIMITED',
        remaining: 0,
        resets_at: rl.resetsAt,
      });
    }
    wallet = { credit_balance: 99.00 }; // guest — no DB wallet
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

    if (isGuest) {
      // Record server-side usage so the next request is counted correctly
      await recordGuestUsage(user_id, ipHash);
    } else {
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

// ── POST /api/top-up  (Stripe webhook receiver) ───────────────────────────────
// express.raw() is mounted on this route above so req.body is a Buffer.
app.post('/api/top-up', async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn('[top-up] Stripe not configured — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing');
    return res.status(503).json({ error: 'Payment processing not configured.' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header.' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[top-up] Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Idempotency guard — log the event id to avoid double-crediting
  const eventId = event.id;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO stripe_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, [eventId]
    );
    if (rowCount === 0) {
      // Already processed
      console.log(`[top-up] Duplicate event ${eventId} — ignored`);
      return res.json({ received: true, duplicate: true });
    }
  } catch (err) {
    // stripe_events table may not exist yet — log warning but continue
    console.warn('[top-up] Could not record event id (stripe_events missing?):', err.message);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId  = session.metadata?.user_id;
      const credits = parseFloat(session.metadata?.credits || '0');
      const amountUsd = (session.amount_total || 0) / 100;

      if (!userId || credits <= 0) {
        console.error('[top-up] checkout.session.completed — missing user_id or credits in metadata');
        return res.status(400).json({ error: 'Missing user_id or credits in session metadata.' });
      }

      const wallet = await creditWallet(
        userId, credits,
        `Top-up · $${amountUsd.toFixed(2)} (${credits} perspectives)`,
        { stripe_session_id: session.id, stripe_event_id: eventId }
      );
      console.log(`[top-up] Credited ${credits} perspectives to user ${userId}. New balance: ${wallet.credit_balance}`);
      return res.json({ received: true, balance: parseFloat(wallet.credit_balance) });
    }

    // Fallback: log and acknowledge unhandled event types
    console.log(`[top-up] Unhandled event type: ${event.type}`);
    res.json({ received: true, ignored: true });
  } catch (err) {
    console.error('[top-up error]', err.message);
    res.status(500).json({ error: 'Could not credit wallet.' });
  }
});

// ── POST /api/create-checkout-session ────────────────────────────────────────
app.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payment processing not configured.' });
  }

  const { credits, price_usd } = req.body;
  if (!credits || !price_usd || credits <= 0 || price_usd <= 0) {
    return res.status(400).json({ error: 'Invalid credits or price.' });
  }

  const userId = req.user.id;
  const amountCents = Math.round(parseFloat(price_usd) * 100);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: `${credits} Divine Perspectives`,
            description: `${credits} AI-powered perspective sessions on Divine Intelligence`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        user_id: userId,
        credits: String(credits),
      },
      success_url: `${APP_URL}/dashboard/wallet?topup=success`,
      cancel_url:  `${APP_URL}/dashboard/wallet/topup`,
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[create-checkout-session]', err.message);
    res.status(500).json({ error: 'Could not create checkout session.' });
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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
  console.log(`  Stripe:        ${STRIPE_SECRET_KEY ? 'configured ✓' : 'NOT SET ⚠'}`);
  console.log(`  DB:            ${process.env.DATABASE_URL ? 'configured ✓' : 'NOT SET ⚠'}`);
});
