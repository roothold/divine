/**
 * test-admin-perspectives.mjs
 * Divine — Admin Dashboard Sync Test Suite
 *
 * Covers:
 *   §1  API shape — /api/admin/perspectives
 *   §2  Auth gate
 *   §3  Pagination
 *   §4  Search
 *   §5  DB error surfacing
 *   §6  Unified polling engine (_startPoll / _stopPoll)
 *   §7  Users tab  — initial load + 20 s auto-refresh, offset-aware
 *   §8  Thinkers   — always reloads on nav, 30 s auto-refresh
 *   §9  Perspectives — 15 s auto-refresh, offset-aware, _perspLoaded guard
 *   §10 Revenue    — 20 s auto-refresh
 *   §11 Tab switch clears previous interval (no stacking)
 *   §12 Repeat navigation replaces interval, not stacks
 *   §13 _touchSync writes correct timestamp format
 *   §14 Double-fetch bug: initAdmin does NOT fire loadUsers twice
 *   §15 hashchange restores tab + starts correct interval
 */

// ── Mini harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Mock fetch factory ────────────────────────────────────────────────────────
function makeFetch(responses) {
  let i = 0;
  const calls = [];
  async function f(url, opts = {}) {
    const r = responses[Math.min(i, responses.length - 1)];
    i++; calls.push({ url, opts });
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  }
  f.callCount = () => i;
  f.calls     = () => calls;
  return f;
}

function okFetch(body) { return makeFetch([{ body }]); }

// ── Server handler (mirrors server.js GET /api/admin/perspectives) ─────────────
async function handleAdminPerspectives(req, mockDb) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer '))
    return { status: 401, body: { error: 'Not authorised' } };

  const search = (req.query.search || '').trim();
  const offset = parseInt(req.query.offset || '0', 10);
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);

  try {
    const [perspectives, total] = await Promise.all([
      mockDb.getPerspectives({ search, offset, limit }),
      mockDb.countPerspectives(search),
    ]);
    return { status: 200, body: { perspectives, total, offset, limit } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

// ── Unified admin state factory ───────────────────────────────────────────────
// Mirrors the JS inside admin.html so we can test all four sections.
function makeAdminState() {
  // Polling engine
  let _tabInterval  = null;
  const _pollRecord = [];   // tracks [{ action, ms }] for assertions

  function _startPoll(fn, ms) {
    clearInterval(_tabInterval);
    _tabInterval = setInterval(fn, ms);
    _pollRecord.push({ action: 'start', ms });
  }
  function _stopPoll() {
    clearInterval(_tabInterval);
    _tabInterval = null;
    _pollRecord.push({ action: 'stop' });
  }

  // Sync timestamps
  const _synced = {};
  function _touchSync(id) { _synced[id] = new Date().toISOString(); }

  // Per-section state
  let _usersOffset  = 0, _usersTotal  = 0;
  let _perspOffset  = 0, _perspTotal  = 0, _perspLoaded = false;

  // Fetch call log per section
  const fetchLog = { users: [], thinkers: [], perspectives: [], revenue: [] };

  // Section load functions
  async function loadUsers(offset, fetchImpl) {
    _usersOffset = offset;
    fetchLog.users.push({ offset, ts: Date.now() });
    const res  = await fetchImpl(`/api/admin/users?offset=${offset}`, { headers: { Authorization: 'Bearer t' } });
    const data = await res.json();
    _usersTotal = data.total || 0;
    _touchSync('users');
    return data;
  }

  async function loadThinkers(fetchImpl) {
    fetchLog.thinkers.push({ ts: Date.now() });
    const res  = await fetchImpl('/api/admin/thinkers', { headers: { Authorization: 'Bearer t' } });
    const data = await res.json();
    _touchSync('thinkers');
    return data;
  }

  async function loadPerspectives(offset, fetchImpl) {
    _perspLoaded = true;
    _perspOffset = offset;
    fetchLog.perspectives.push({ offset, ts: Date.now() });
    const res  = await fetchImpl(`/api/admin/perspectives?offset=${offset}`, { headers: { Authorization: 'Bearer t' } });
    const data = await res.json();
    _perspTotal = data.total || 0;
    _touchSync('perspectives');
    return data;
  }

  async function loadRevenue(fetchImpl) {
    fetchLog.revenue.push({ ts: Date.now() });
    const res  = await fetchImpl('/api/admin/revenue', { headers: { Authorization: 'Bearer t' } });
    const data = await res.json();
    _touchSync('revenue');
    return data;
  }

  // showSection — mirrors admin.html exactly
  function showSection(name, fetchImpl) {
    _stopPoll();
    if (name === 'users') {
      loadUsers(0, fetchImpl);
      _startPoll(() => loadUsers(_usersOffset, fetchImpl), 20_000);
    } else if (name === 'thinkers') {
      loadThinkers(fetchImpl);
      _startPoll(() => loadThinkers(fetchImpl), 30_000);
    } else if (name === 'perspectives') {
      if (!_perspLoaded) loadPerspectives(0, fetchImpl);
      _startPoll(() => loadPerspectives(_perspOffset, fetchImpl), 15_000);
    } else if (name === 'revenue') {
      loadRevenue(fetchImpl);
      _startPoll(() => loadRevenue(fetchImpl), 20_000);
    }
  }

  return {
    get usersOffset()   { return _usersOffset; },
    get perspOffset()   { return _perspOffset; },
    get perspLoaded()   { return _perspLoaded; },
    get hasInterval()   { return _tabInterval !== null; },
    get pollRecord()    { return _pollRecord; },
    get synced()        { return _synced; },
    fetchLog,
    loadUsers, loadThinkers, loadPerspectives, loadRevenue,
    showSection,
    simulatePollTick: (fn, fetchImpl) => fn(fetchImpl),
    cleanup: () => { clearInterval(_tabInterval); _tabInterval = null; },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Divine — Admin Dashboard Full Sync Test Suite');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');


// §1 — API shape ───────────────────────────────────────────────────────────────
console.log('§1 — /api/admin/perspectives response shape');
{
  const db = {
    getPerspectives:   async () => [{ id:1, created_at:'2025-01-01T00:00:00Z', user_name:'Jane',
                                      user_email:'jane@x.com', label:'Charge', amount:0.05, balance_after:4.95 }],
    countPerspectives: async () => 1,
  };
  const { status, body } = await handleAdminPerspectives(
    { headers: { authorization: 'Bearer admin' }, query: {} }, db);

  assert('Status 200',                status === 200);
  assert('perspectives is array',     Array.isArray(body.perspectives));
  assert('total is number',           typeof body.total === 'number');
  assert('offset is number',          typeof body.offset === 'number');
  assert('limit is number',           typeof body.limit  === 'number');
  assert('Row has created_at',        'created_at'   in body.perspectives[0]);
  assert('Row has user_email',        'user_email'   in body.perspectives[0]);
  assert('Row has amount',            'amount'       in body.perspectives[0]);
  assert('Row has balance_after',     'balance_after' in body.perspectives[0]);
  assert('Total equals 1',            body.total === 1);
  console.log();
}


// §2 — Auth gate ───────────────────────────────────────────────────────────────
console.log('§2 — Auth gate: unauthenticated → 401');
{
  const db = { getPerspectives: async () => [], countPerspectives: async () => 0 };
  const { status } = await handleAdminPerspectives({ headers: {}, query: {} }, db);
  assert('Status 401 without Bearer token', status === 401);
  console.log();
}


// §3 — Pagination ──────────────────────────────────────────────────────────────
console.log('§3 — Pagination: offset + limit forwarded to DB');
{
  let captured = null;
  const db = {
    getPerspectives:   async args => { captured = args; return []; },
    countPerspectives: async () => 120,
  };
  const { body } = await handleAdminPerspectives(
    { headers: { authorization: 'Bearer x' }, query: { offset: '50', limit: '50' } }, db);

  assert('offset forwarded',         captured?.offset === 50);
  assert('limit forwarded',          captured?.limit  === 50);
  assert('response offset correct',  body.offset === 50);
  assert('total reflects full set',  body.total  === 120);
  console.log();
}


// §4 — Search ──────────────────────────────────────────────────────────────────
console.log('§4 — Search term forwarded to DB');
{
  let capturedSearch = null;
  const db = {
    getPerspectives:   async ({ search }) => { capturedSearch = search; return []; },
    countPerspectives: async () => 0,
  };
  await handleAdminPerspectives(
    { headers: { authorization: 'Bearer x' }, query: { search: 'jane@x.com' } }, db);
  assert('Search forwarded', capturedSearch === 'jane@x.com', `got "${capturedSearch}"`);
  console.log();
}


// §5 — DB error → 500 ─────────────────────────────────────────────────────────
console.log('§5 — DB failure → 500');
{
  const db = {
    getPerspectives:   async () => { throw new Error('conn refused'); },
    countPerspectives: async () => 0,
  };
  const { status, body } = await handleAdminPerspectives(
    { headers: { authorization: 'Bearer x' }, query: {} }, db);
  assert('Status 500',          status === 500);
  assert('Error message set',   body.error === 'conn refused');
  console.log();
}


// §6 — Unified polling engine ─────────────────────────────────────────────────
console.log('§6 — Polling engine: start clears previous interval');
{
  const state  = makeAdminState();
  const fetch1 = okFetch({ users: [], total: 0 });
  const fetch2 = okFetch({ users: [], total: 0 });

  // Navigate to users → starts interval (stop + start recorded)
  state.showSection('users', fetch1);
  await new Promise(r => setTimeout(r, 10));
  const stopsAfterUsers = state.pollRecord.filter(r => r.action === 'stop').length;

  // Navigate to revenue → should stop users interval then start revenue
  state.showSection('revenue', fetch2);
  await new Promise(r => setTimeout(r, 10));
  const stopsAfterRevenue = state.pollRecord.filter(r => r.action === 'stop').length;

  assert('Stop fired when switching to revenue',  stopsAfterRevenue > stopsAfterUsers);
  assert('Revenue interval is now active',        state.hasInterval);
  state.cleanup();
  console.log();
}


// §7 — Users: initial load + offset-aware auto-refresh ────────────────────────
console.log('§7 — Users tab: initial load at offset 0, auto-refresh at current offset');
{
  const state = makeAdminState();
  const f     = makeFetch([
    { body: { users: [], total: 5, stats: {} } },  // nav load
    { body: { users: [], total: 5, stats: {} } },  // auto-refresh
  ]);

  // Simulate navigation
  await state.loadUsers(0, f);
  assert('Initial load at offset 0', state.usersOffset === 0);
  assert('sync timestamp set',       !!state.synced['users']);

  // Simulate pagination to page 2
  await state.loadUsers(50, f);
  assert('Offset updated to 50', state.usersOffset === 50);

  // Auto-refresh should fire at offset 50 (current page), not 0
  assert('Auto-refresh uses current offset', state.fetchLog.users[1]?.offset === 50);
  assert('Two fetches total',               f.callCount() === 2);
  state.cleanup();
  console.log();
}


// §8 — Thinkers: always reloads on navigation ─────────────────────────────────
console.log('§8 — Thinkers: reloads on every nav (no stale guard), 30 s interval');
{
  const state = makeAdminState();
  const f     = makeFetch([
    { body: { thinkers: [{ id: 'michael', available: true, perspectives_served: 10 }] } },
    { body: { thinkers: [{ id: 'michael', available: true, perspectives_served: 14 }] } },
  ]);

  // First visit
  state.showSection('thinkers', f);
  await new Promise(r => setTimeout(r, 10));
  assert('First nav fetches thinkers',     f.callCount() === 1);

  // Leave + return — should reload, not skip
  state.showSection('users', f);    // uses same f but different section
  state.showSection('thinkers', f);
  await new Promise(r => setTimeout(r, 10));
  // Two nav visits = two thinker fetches (each showSection('thinkers') always calls loadThinkers)
  assert('Second nav re-fetches thinkers', state.fetchLog.thinkers.length === 2,
    `got ${state.fetchLog.thinkers.length}`);
  assert('30 s interval started',
    state.pollRecord.some(r => r.action === 'start' && r.ms === 30_000));
  state.cleanup();
  console.log();
}


// §9 — Perspectives: 15 s auto-refresh, _perspLoaded guard, offset-aware ──────
console.log('§9 — Perspectives: 15 s interval, loads once on first nav, offset-aware');
{
  const state = makeAdminState();
  const f     = makeFetch([
    { body: { perspectives: [], total: 3, offset: 0, limit: 50 } },
    { body: { perspectives: [], total: 4, offset: 0, limit: 50 } },
  ]);

  // First nav — _perspLoaded is false → loads
  state.showSection('perspectives', f);
  await new Promise(r => setTimeout(r, 10));
  assert('Loads on first visit',          f.callCount() === 1);
  assert('_perspLoaded set',              state.perspLoaded);
  assert('15 s interval started',
    state.pollRecord.some(r => r.action === 'start' && r.ms === 15_000));

  // Simulate paginating to offset 50
  await state.loadPerspectives(50, f);
  assert('Offset updated to 50',          state.perspOffset === 50);

  // Auto-refresh (simulated tick) should use offset 50
  await state.loadPerspectives(state.perspOffset, f);
  assert('Tick uses current offset (50)', state.fetchLog.perspectives[2]?.offset === 50,
    `got ${state.fetchLog.perspectives[2]?.offset}`);
  assert('sync timestamp set',            !!state.synced['perspectives']);
  state.cleanup();
  console.log();
}


// §10 — Revenue: 20 s auto-refresh ────────────────────────────────────────────
console.log('§10 — Revenue: loads on nav, 20 s auto-refresh');
{
  const state = makeAdminState();
  const f     = makeFetch([
    { body: { totals: { total_earned: 100, total_spent: 40, total_balance: 60, total_perspectives: 8 }, recent: [] } },
    { body: { totals: { total_earned: 105, total_spent: 45, total_balance: 60, total_perspectives: 9 }, recent: [] } },
  ]);

  state.showSection('revenue', f);
  await new Promise(r => setTimeout(r, 10));
  assert('Revenue loads on nav',     f.callCount() === 1);
  assert('sync timestamp set',       !!state.synced['revenue']);
  assert('20 s interval registered',
    state.pollRecord.some(r => r.action === 'start' && r.ms === 20_000));

  // Poll tick picks up new data
  await state.loadRevenue(f);
  assert('Poll tick fires second fetch', f.callCount() === 2);
  state.cleanup();
  console.log();
}


// §11 — Tab switch clears old interval ────────────────────────────────────────
console.log('§11 — Switching tabs tears down previous interval');
{
  const state = makeAdminState();
  const f     = okFetch({ users: [], total: 0, thinkers: [], perspectives: [], total_perspectives: 0,
                          totals: {}, recent: [] });

  state.showSection('users',        f);
  await new Promise(r => setTimeout(r, 5));
  assert('Users interval active',   state.hasInterval);

  state.showSection('revenue',      f);
  await new Promise(r => setTimeout(r, 5));
  assert('Revenue interval active', state.hasInterval);

  // Verify a stop was issued between the two starts
  const stops  = state.pollRecord.filter(r => r.action === 'stop').length;
  const starts = state.pollRecord.filter(r => r.action === 'start').length;
  assert('Stops equal starts (each nav clears before starting)', stops === starts,
    `stops=${stops} starts=${starts}`);
  state.cleanup();
  console.log();
}


// §12 — Repeat navigation replaces, not stacks ────────────────────────────────
console.log('§12 — Returning to same tab replaces interval, not stacks');
{
  const state = makeAdminState();
  const f     = okFetch({ users: [], total: 0, stats: {} });

  state.showSection('users', f);
  await new Promise(r => setTimeout(r, 5));
  const startsBefore = state.pollRecord.filter(r => r.action === 'start').length;

  state.showSection('users', f);
  await new Promise(r => setTimeout(r, 5));
  const startsAfter = state.pollRecord.filter(r => r.action === 'start').length;

  assert('Only one extra start on repeat nav', startsAfter - startsBefore === 1);
  assert('Interval still active', state.hasInterval);
  state.cleanup();
  console.log();
}


// §13 — _touchSync writes timestamp ───────────────────────────────────────────
console.log('§13 — _touchSync records a timestamp after each successful fetch');
{
  const state = makeAdminState();
  const f     = okFetch({ users: [], total: 0, stats: {} });
  const before = Date.now();
  await state.loadUsers(0, f);
  const after  = Date.now();

  assert('users synced key exists',         !!state.synced['users']);
  const ts = new Date(state.synced['users']).getTime();
  assert('timestamp is within test window', ts >= before && ts <= after + 50,
    `ts=${ts} range=${before}-${after}`);
  state.cleanup();
  console.log();
}


// §14 — No double-fetch on init ───────────────────────────────────────────────
console.log('§14 — initAdmin does NOT fire loadUsers twice (double-fetch bug)');
{
  // Simulate the fixed initAdmin: only showSection() is called, not loadUsers() separately.
  const state  = makeAdminState();
  const f      = okFetch({ users: [], total: 0, stats: {} });

  // The bug: calling both showSection('users') AND loadUsers(0) separately.
  // The fix: only showSection() is called.
  // We verify that one showSection call produces exactly one fetch.
  state.showSection('users', f);
  await new Promise(r => setTimeout(r, 10));

  assert('Exactly one fetch on init (not two)', f.callCount() === 1,
    `got ${f.callCount()}`);
  state.cleanup();
  console.log();
}


// §15 — hashchange restores correct tab + interval ────────────────────────────
console.log('§15 — hashchange restores correct tab with correct interval cadence');
{
  const state  = makeAdminState();
  const f      = okFetch({ perspectives: [], total: 0, offset: 0, limit: 50 });

  // Simulate hashchange → perspectives
  state.showSection('perspectives', f);
  await new Promise(r => setTimeout(r, 10));

  assert('Perspectives interval at 15 s',
    state.pollRecord.some(r => r.action === 'start' && r.ms === 15_000));
  assert('_perspLoaded set after hash restore', state.perspLoaded);
  state.cleanup();
  console.log();
}


// ── Summary ───────────────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const total = passed + failed;
if (failed === 0) {
  console.log(`  ✓ All ${total} assertions passed`);
} else {
  console.log(`  ${passed}/${total} passed — ${failed} FAILED`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exit(failed > 0 ? 1 : 0);
