/**
 * Divine Intelligence — Production Server v3
 *
 * Routes:
 *   GET  /                     → Serve app
 *   GET  /health               → Status + DB check
 *   GET  /api/balance          → Fetch wallet balance (create if new user)
 *   POST /api/get-perspective  → Stream AI insight, deduct $0.05
 *   POST /api/top-up           → Payment webhook (Stripe / Shift4)
 *
 * Brand voice: Direct, not cold. Precise, not clever.
 */

import 'dotenv/config';
import express            from 'express';
import { readFileSync }   from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import Anthropic          from '@anthropic-ai/sdk';
import pool, { getOrCreateWallet, deductCredit, creditWallet } from './db.js';
import { getThinker }     from './thinkers.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const app        = express();
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Constants ────────────────────────────────────────────────────────────────
const INSIGHT_COST    = parseFloat(process.env.INSIGHT_COST   || '0.05');
const MAIN_MODEL      = process.env.ANTHROPIC_MODEL            || 'claude-sonnet-4-5';
const SUMMARY_MODEL   = 'claude-haiku-4-5';   // cheap model for context compression
const MAX_CTX_CHARS   = 12_000;               // ~3 000 tokens — summarise above this
const PORT            = parseInt(process.env.PORT              || '3001');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ── Middleware ───────────────────────────────────────────────────────────────
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

// Raw body for webhook — must come before express.json()
app.use('/api/top-up', express.raw({ type: '*/*' }));
app.use(express.json());

// ── Serve app ────────────────────────────────────────────────────────────────
const HTML_FILE = join(__dirname, 'index.html');
app.get('/', (_req, res) => {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(readFileSync(HTML_FILE, 'utf8'));
  } catch {
    res.status(404).send('App not found.');
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', model: MAIN_MODEL, db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: err.message });
  }
});

// ── GET /api/balance ─────────────────────────────────────────────────────────
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

// ── POST /api/get-perspective ─────────────────────────────────────────────────
app.post('/api/get-perspective', async (req, res) => {
  const { user_id, thinker_id, stage, decision, answers } = req.body;

  if (!user_id)    return res.status(400).json({ error: 'user_id is required.'    });
  if (!thinker_id) return res.status(400).json({ error: 'thinker_id is required.' });
  if (!stage)      return res.status(400).json({ error: 'stage is required.'      });

  // 1. Wallet check
  let wallet;
  try {
    wallet = await getOrCreateWallet(user_id);
  } catch (err) {
    console.error('[wallet check]', err.message);
    return res.status(500).json({ error: 'Could not verify balance. Try again.' });
  }

  if (parseFloat(wallet.credit_balance) < INSIGHT_COST) {
    return res.status(402).json({
      error:   'Your balance is empty. Top up to continue.',
      code:    'INSUFFICIENT_FUNDS',
      balance: parseFloat(wallet.credit_balance),
    });
  }

  // 2. Load thinker profile
  const thinker = getThinker(thinker_id);
  if (!thinker) return res.status(404).json({ error: 'Thinker not found.' });

  // 3. Context management
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
        console.log(`[context] Compressing ${historyStr.length} chars for ${user_id}`);
        const summaryRes = await anthropic.messages.create({
          model: SUMMARY_MODEL, max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Summarise this conversation in 3-5 bullet points, keeping only the key decisions, insights, and context that affect future advice:\n\n${historyStr}`,
          }],
        });
        summaryPrefix       = summaryRes.content[0].text;
        conversationHistory = [];
      }
    }
  } catch (err) {
    console.error('[context load]', err.message);
  }

  // 4. Build user message for this stage
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

  // 5. Build messages array
  const messages = [
    ...(summaryPrefix
      ? [{ role: 'user',      content: `[Prior session summary]\n${summaryPrefix}` },
         { role: 'assistant', content: 'Understood. I have the context.' }]
      : []),
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  // 6. Stream with prompt caching
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let fullText = '';

  try {
    const stream = anthropic.messages.stream({
      model:      MAIN_MODEL,
      max_tokens: 1024,
      system: [{
        type:          'text',
        text:          thinker.systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages,
    });

    stream.on('text', (text) => {
      fullText += text;
      res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    });

    const finalMsg = await stream.finalMessage();

    // 7. Deduct credit
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

    // 8. Save context
    const newHistory = [
      ...conversationHistory,
      { role: 'user',      content: userMessage },
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

    // 9. Send final balance
    const updated = await getOrCreateWallet(user_id).catch(() => null);
    res.write(`data: ${JSON.stringify({
      type:    'done',
      balance: updated ? parseFloat(updated.credit_balance) : null,
    })}\n\n`);
    res.end();

  } catch (err) {
    console.error('[stream error]', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Something went wrong. Your balance has not been charged.' })}\n\n`);
    res.end();
  }
});

// ── POST /api/top-up ─────────────────────────────────────────────────────────
app.post('/api/top-up', async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload.' });
  }

  const handle = async (userId, credits, amountUsd, metadata) => {
    if (!userId || credits <= 0) {
      console.error('[top-up] Missing user_id or credits', metadata);
      return res.status(400).json({ error: 'Missing user_id or credits in payment metadata.' });
    }
    const wallet = await creditWallet(userId, credits, `Top-up · $${amountUsd.toFixed(2)}`, metadata);
    console.log(`[top-up] ${userId} +$${credits} → balance $${wallet.credit_balance}`);
    res.json({ received: true, balance: parseFloat(wallet.credit_balance) });
  };

  try {
    // Stripe: payment_intent.succeeded
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data?.object;
      await handle(
        intent?.metadata?.user_id,
        parseFloat(intent?.metadata?.credits || '0'),
        (intent?.amount_received || 0) / 100,
        { payment_intent_id: intent?.id }
      );
      return;
    }

    // Shift4: PAYMENT_UPDATED / SUCCESSFUL
    if (event.type === 'PAYMENT_UPDATED' && event.data?.status === 'SUCCESSFUL') {
      const p = event.data;
      await handle(
        p.metadata?.user_id,
        parseFloat(p.metadata?.credits || '0'),
        (p.amount || 0) / 100,
        { shift4_payment_id: p.id }
      );
      return;
    }

    // Unknown event — acknowledge
    res.json({ received: true, ignored: true });

  } catch (err) {
    console.error('[top-up error]', err.message);
    res.status(500).json({ error: 'Could not credit wallet.' });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Divine Intelligence] Running on :${PORT}`);
  console.log(`  Model:         ${MAIN_MODEL}`);
  console.log(`  Summary model: ${SUMMARY_MODEL}`);
  console.log(`  Insight cost:  $${INSIGHT_COST}`);
  console.log(`  DB:            ${process.env.DATABASE_URL ? 'configured' : 'NOT SET ⚠'}`);
});
