# Divine — Launch Plan & Checklist

**Product:** Divine — cognitive marketplace, $0.05 per insight
**Stack:** Node.js / Express · PostgreSQL · Anthropic API · Railway
**Target payment processor:** Shift4 (primary) · Stripe (fallback)

---

## Where Things Stand Right Now

| Area | Status |
|---|---|
| Frontend (index.html) | ✅ Complete — all screens, top-up modal, balance bar |
| Express server + streaming AI | ✅ Complete |
| PostgreSQL schema & wallet logic | ✅ Complete |
| Railway deployment | ✅ Live |
| Shift4 / Stripe checkout | ❌ `handleTopup()` shows an alert — not wired |
| Webhook handler in server.js | ✅ Handler code exists — needs env vars |
| Thinker auth | ⚠️ `isThinker()` returns `true` always |
| Thinker reports (DB) | ⚠️ Shows mock zeros |
| Custom domain | ❌ Not configured |
| Legal pages | ❌ Missing |

---

## Phase 1 — Payment Integration (Days 1–3)

This is the critical path. Everything else is secondary.

### Recommended path: Stripe Checkout (simpler, faster to test)
Shift4 is solid for hospitality/enterprise but their hosted checkout docs are sparse. Stripe's hosted checkout is one API call and has a Node SDK with full TypeScript types. You can switch to Shift4 later once revenue is flowing if you prefer. The webhook handler in `server.js` already handles both.

### Shift4 path (if you want to stick with it)
Shift4's hosted checkout product is called **Checkout** (US) or **PLI** in some regions. You create a charge with `hosted: true` and get back a `checkoutUrl`. Their Node SDK is `shift4` on npm.

---

## Phase 2 — Infrastructure (Days 2–4)

Ensure Railway env vars, CORS, rate limiting, and monitoring are solid before taking real money.

---

## Phase 3 — Access Control & Thinker Auth (Days 3–5)

Lock down `isThinker()` and build a real approval flow.

---

## Phase 4 — Legal & Pre-Launch (Days 4–6)

Privacy Policy, Terms of Service, custom domain, end-to-end QA.

---

## Phase 5 — Launch (Day 7)

Soft launch with beta Thinkers. Monitor Anthropic costs vs. revenue.

---

---

# Full Launch Checklist

## 💳 PAYMENT INTEGRATION

### Option A — Stripe (Recommended for speed)

#### Setup
- [ ] Create a Stripe account at stripe.com if you don't have one
- [ ] In Stripe Dashboard → Developers → API Keys, copy **Secret key** (sk_test_...) and **Publishable key** (pk_test_...)
- [ ] Add to Railway env vars: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] In project terminal: `npm install stripe`
- [ ] Add `stripe` to package.json dependencies

#### Server — create checkout session endpoint
- [ ] Add `POST /api/create-checkout` route to `server.js`:

```js
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/api/create-checkout', express.json(), async (req, res) => {
  const { user_id, credits, price_cents } = req.body;
  if (!user_id || !credits || !price_cents) return res.status(400).json({ error: 'Missing params' });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `${credits} Divine Credits` },
        unit_amount: price_cents,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${process.env.APP_URL}?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}?topup=cancelled`,
    metadata: { user_id, credits: String(credits) },
  });

  res.json({ url: session.url });
});
```

- [ ] Add `APP_URL` to Railway env vars (your live Railway URL or custom domain)

#### Webhook — wire up existing handler
- [ ] In Stripe Dashboard → Developers → Webhooks → Add endpoint
  - URL: `https://your-railway-domain.railway.app/api/top-up`
  - Events: `checkout.session.completed`
- [ ] Copy the Webhook Signing Secret and set `STRIPE_WEBHOOK_SECRET` in Railway
- [ ] Update the webhook handler in `server.js` to handle `checkout.session.completed`:

```js
// In the /api/top-up handler, add:
if (event.type === 'checkout.session.completed') {
  const session = event.data.object;
  const userId  = session.metadata?.user_id;
  const credits = parseInt(session.metadata?.credits || '0', 10);
  if (userId && credits) {
    const wallet = await creditWallet(userId, credits);
    console.log(`[stripe] credited ${credits} to ${userId} → $${wallet.credit_balance}`);
  }
}
```

- [ ] Verify Stripe signature using `stripe.webhooks.constructEvent(req.body, sig, secret)`

#### Frontend — wire up handleTopup()
- [ ] Replace the `alert()` in `handleTopup()` in `index.html` with:

```js
async function handleTopup() {
  const pkg = selectedPkgEl || document.querySelector('.topup-pkg.selected');
  if (!pkg) return;
  const credits    = parseInt(pkg.dataset.credits);
  const priceCents = Math.round(parseFloat(pkg.dataset.price) * 100);
  const btn = document.getElementById('topup-cta');
  btn.disabled = true;
  btn.textContent = 'Redirecting…';
  try {
    const res  = await fetch(`${API_BASE}/api/create-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: USER_ID, credits, price_cents: priceCents }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else throw new Error(data.error || 'No checkout URL');
  } catch (e) {
    showToast('Payment error — please try again');
    btn.disabled = false;
    btn.textContent = 'Continue to payment';
  }
}
```

- [ ] On page load, check `?topup=success` in URL and call `fetchBalance()` + show toast "Credits added!"
- [ ] On page load, check `?topup=cancelled` and show toast "Payment cancelled"

#### Test the full loop
- [ ] Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC
- [ ] Confirm webhook fires and wallet is credited in Railway Postgres (check via Railway Query tab)
- [ ] Confirm balance bar updates when user returns to app

---

### Option B — Shift4 (If you prefer)

#### Setup
- [ ] Sign up at shift4.com for a developer account
- [ ] Copy Secret Key from Shift4 dashboard
- [ ] `npm install shift4`
- [ ] Add `SHIFT4_SECRET_KEY` and `SHIFT4_WEBHOOK_SECRET` to Railway env vars

#### Server — create charge with hosted checkout

```js
const Shift4 = require('shift4');
const s4 = new Shift4(process.env.SHIFT4_SECRET_KEY);

app.post('/api/create-checkout', express.json(), async (req, res) => {
  const { user_id, credits, price_cents } = req.body;
  const charge = await s4.charges.create({
    amount: price_cents,
    currency: 'USD',
    description: `${credits} Divine Credits`,
    metadata: { user_id, credits: String(credits) },
    flow: 'hosted',
    hosted: { successUrl: `${process.env.APP_URL}?topup=success`, failureUrl: `${process.env.APP_URL}?topup=cancelled` }
  });
  res.json({ url: charge.hosted?.redirectUrl });
});
```

- [ ] Webhook handler already handles `PAYMENT_UPDATED/SUCCESSFUL` — add your secret key validation
- [ ] Register webhook endpoint in Shift4 dashboard → point to `/api/top-up`
- [ ] Test with Shift4 test card: `4242424242424242`

---

## 🗄️ INFRASTRUCTURE

### Railway Configuration
- [ ] In Railway → Divine service → Variables, confirm all env vars are set:
  - `ANTHROPIC_API_KEY`
  - `DATABASE_URL` (auto-set by Postgres plugin — verify it's linked)
  - `NODE_ENV=production`
  - `PORT` (Railway auto-sets this)
  - `INSIGHT_COST=0.05`
  - `APP_URL` (your Railway domain or custom domain)
  - `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (or Shift4 equivalents)
- [ ] Confirm Railway Postgres plugin is attached to the Divine service (not just provisioned)
- [ ] Run schema.sql in Railway Query tab — paste contents and execute once

### Database
- [ ] Verify `wallets`, `transactions`, `conversation_contexts` tables exist in Railway Postgres
- [ ] Test `GET /api/balance?user_id=test123` returns `{ balance: 0 }`
- [ ] Test `POST /api/top-up` webhook with a simulated payload returns 200

### Security & Performance
- [ ] Add rate limiting: `npm install express-rate-limit` → 60 req/min per IP on `/api/get-perspective`
- [ ] Confirm CORS `ALLOWED_ORIGINS` env var is set to your production domain only
- [ ] Set `helmet` headers: `npm install helmet` → `app.use(require('helmet')())`
- [ ] Add basic request logging: `npm install morgan` → `app.use(require('morgan')('combined'))`
- [ ] Verify streaming endpoint closes SSE connection cleanly on client disconnect

### Monitoring
- [ ] Set up free Sentry account → add `SENTRY_DSN` env var → `npm install @sentry/node`
- [ ] Add Railway health-check URL to an uptime monitor (UptimeRobot free tier is fine)
- [ ] Set a Railway spend limit to avoid surprise bills

---

## 🔐 ACCESS CONTROL & AUTH

### Thinker Portal
- [ ] Replace `isThinker() { return true; }` with real check:

```js
function isThinker() {
  const email = localStorage.getItem('di_user_email') || '';
  const APPROVED = ['michael@surpluspods.com']; // add approved emails here
  return APPROVED.includes(email.toLowerCase());
}
```

- [ ] Add an email-capture step (simple prompt or login modal) so `di_user_email` gets set
- [ ] Hide `nav-thinker` button for non-thinkers (it should already check `isThinker()` in `initNav()`)
- [ ] Optionally: move APPROVED list to a Railway env var `APPROVED_THINKER_EMAILS` and expose via a `/api/me` endpoint

### User Identity
- [ ] Current: device-based UUID in localStorage — fine for beta
- [ ] Future: proper auth (Clerk, Auth0, or Supabase Auth) — not required for launch

---

## ⚖️ LEGAL

- [ ] Write or generate a **Privacy Policy** — must cover: data collected (device ID, payment info via Stripe/Shift4), cookies, third-party AI processing
- [ ] Write or generate **Terms of Service** — must cover: $0.05/insight pricing, no refund policy for credits, acceptable use, AI disclaimer
- [ ] Add links to both in the app footer
- [ ] If collecting payments: ensure your Stripe/Shift4 account has a business address and refund policy configured (required by card networks)

---

## 🌐 DOMAIN & BRANDING

- [ ] Purchase `divine.ai` or `divineintelligence.co` or similar (Namecheap / Cloudflare Registrar)
- [ ] In Railway → Settings → Networking → Custom Domain → add your domain
- [ ] Update DNS at your registrar: CNAME `divine.yourdomain.com` → Railway-provided hostname
- [ ] Wait for SSL cert (Railway auto-provisions via Let's Encrypt, ~5 min)
- [ ] Update `APP_URL` env var to your custom domain
- [ ] Update Stripe/Shift4 webhook endpoint URL to use custom domain
- [ ] Update Stripe `success_url` and `cancel_url` to use custom domain

---

## 🧪 END-TO-END QA

### Buyer flow
- [ ] Open app on a fresh browser (no localStorage)
- [ ] Run a full insight: enter perspective → questions → match → reframe
- [ ] Confirm wallet balance shows and decrements $0.05 per insight
- [ ] When balance hits 0, confirm the top-up modal appears
- [ ] Complete a test purchase → confirm redirect back to app → confirm balance updated
- [ ] Repeat insight — confirm it works with new balance

### Thinker flow
- [ ] Log in as an approved thinker email
- [ ] Confirm Thinker tab visible in sidebar
- [ ] Complete onboarding flow (all 6 steps)
- [ ] Save framework in Train Model tab
- [ ] Check that Reports tab loads (even if showing zeros for now)

### Edge cases
- [ ] What happens if Anthropic API is down? (Should show a friendly error, not crash)
- [ ] What happens if user refreshes mid-stream? (Should recover gracefully)
- [ ] What happens if payment webhook arrives twice? (Idempotency — verify `creditWallet()` handles duplicates)

---

## 🚀 LAUNCH

### Soft launch (Day 1)
- [ ] Invite 3–5 beta users manually — share the URL directly
- [ ] Give each $1 of free credits — `INSERT INTO wallets (user_id, credit_balance) VALUES ('their-uuid', 20)` in Railway Query
- [ ] Watch Railway logs for errors during their sessions
- [ ] Collect feedback on the insight quality and UI

### Go-live
- [ ] Switch Stripe from test mode to live mode (new API keys — update Railway env vars)
- [ ] Remove any hardcoded test data or `console.log` with sensitive info
- [ ] Post launch announcement

### Post-launch monitoring
- [ ] Daily: check Railway Postgres — total wallets, total transactions, revenue
- [ ] Daily: check Anthropic usage dashboard — cost per insight (should be well under $0.05)
- [ ] Weekly: review Thinker earnings in Reports tab (once real DB endpoint is wired)
- [ ] Monthly: reconcile Stripe/Shift4 payouts vs. Postgres transaction ledger

---

## 🔧 REMAINING CODE WORK (post-launch OK)

- [ ] Wire Thinker Reports to real DB endpoint (`GET /api/thinker/report?thinker_id=...`)
- [ ] Wire Thinker Payments to a Stripe Connect or Shift4 payout account
- [ ] Add conversation history persistence (currently lives only in-memory per session)
- [ ] Implement `summarizeHistory()` in the frontend so long conversations don't bloat the payload
- [ ] Add a proper admin dashboard to manage wallets and thinkers

---

## Estimated Timeline

| Phase | Work | Days |
|---|---|---|
| Payment integration (Stripe) | Server endpoint + frontend handleTopup + webhook | 1–2 |
| Railway env vars + DB verify | Config work | 0.5 |
| Rate limiting + helmet + Sentry | One-time setup | 0.5 |
| Thinker auth (email check) | Small code change | 0.5 |
| Legal pages | Writing / generation | 1 |
| Custom domain + DNS | Config | 0.5 |
| QA + fixes | Testing | 1 |
| **Total to soft launch** | | **~5–6 days** |

---

*Sources: [Shift4 Developer Docs](https://dev.shift4.com/docs/api/) · [shift4-node on GitHub](https://github.com/shift4developer/shift4-node) · [Stripe Checkout Quickstart](https://docs.stripe.com/checkout/quickstart) · [Stripe Webhooks](https://codehooks.io/docs/examples/webhooks/stripe)*
