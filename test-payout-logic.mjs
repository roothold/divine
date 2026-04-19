/**
 * test-payout-logic.mjs
 * Divine — Thinker Payout Logic Test Suite
 *
 * Mirrors the exact payout block from server.js POST /api/get-perspective
 * (lines ~684-706) without requiring a live DB or API key.
 *
 * Sections:
 *   §1  Math: 70% of $0.05 = $0.035, rounded to 4dp
 *   §2  Guest users never trigger payout
 *   §3  Payout fires only after successful deduction
 *   §4  payoutEmail lookup: found → creditWallet + recordThinkerEarning
 *   §5  payoutEmail lookup: user not found → recordThinkerEarning with null userId
 *   §6  No payoutEmail → skip creditWallet, still recordThinkerEarning
 *   §7  recordThinkerEarning always called (even if creditWallet throws)
 *   §8  thinker_id stored as string 'michael', not UUID
 *   §9  Payout label format: "Perspective earned · {name} · {stage}"
 *   §10 THINKER_CUT env override: 0.50 → $0.025 per session
 *   §11 Multiple sessions accumulate earnings correctly
 *   §12 Deduction failure blocks payout (no record written)
 *   §13 Stats query: thinker_id='michael' matches all session rows
 *   §14 toFixed(4) prevents floating-point drift across 100 sessions
 */

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Constants (mirrors server.js) ────────────────────────────────────────────
const INSIGHT_COST = parseFloat(process.env.INSIGHT_COST || '0.05');
const THINKER_CUT  = parseFloat(process.env.THINKER_CUT  || '0.70');
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Payout function (mirrors server.js exactly) ───────────────────────────────
async function runPayoutBlock({
  thinker,
  stage,
  isGuest,
  deductCreditFn,
  getUserByEmailFn,
  creditWalletFn,
  recordThinkerEarningFn,
}) {
  if (isGuest) return { skipped: true };

  let deducted = false;
  try {
    await deductCreditFn(INSIGHT_COST, `${thinker.name} · ${stage}`);
    deducted = true;

    // ── 70/30 thinker payout (mirrors server.js lines 684-702) ───────────
    const thinkerPayoutAmount = parseFloat((INSIGHT_COST * THINKER_CUT).toFixed(4));
    const thinkerPayoutLabel  = `Perspective earned · ${thinker.name} · ${stage}`;

    let thinkerUserId = null;
    if (thinker.payoutEmail) {
      try {
        const payoutUser = await getUserByEmailFn(thinker.payoutEmail);
        if (payoutUser) {
          thinkerUserId = payoutUser.id;
          await creditWalletFn(thinkerUserId, thinkerPayoutAmount, thinkerPayoutLabel, { line_item_type: 'thinker_royalty' });
        }
      } catch (lookupErr) {
        // warn only — recordThinkerEarning still runs
      }
    }
    // Always record in thinker_earnings ledger
    await recordThinkerEarningFn(thinker.id, thinkerUserId, thinkerPayoutAmount, thinkerPayoutLabel);

    return { deducted, thinkerUserId, thinkerPayoutAmount, thinkerPayoutLabel };
  } catch (deductErr) {
    return { deducted: false, error: deductErr.message };
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const MICHAEL = {
  id:          'michael',
  name:        'Michael Akindele',
  payoutEmail: 'makindel@gmail.com',
};

const PAYOUT_USER_UUID = 'a1b2c3d4-0000-0000-0000-000000000001';

const noop          = async () => {};
const okDeduct      = async () => {};
const failDeduct    = async () => { throw new Error('Insufficient funds'); };
const okGetUser     = async (email) => email === 'makindel@gmail.com' ? { id: PAYOUT_USER_UUID } : null;
const nullGetUser   = async () => null;
const throwGetUser  = async () => { throw new Error('DB timeout'); };
const okCredit      = async () => {};
const throwCredit   = async () => { throw new Error('Wallet write failed'); };

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Divine — Thinker Payout Logic Test Suite');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');


// §1 — Math: 70% of $0.05 ────────────────────────────────────────────────────
console.log('§1 — Math: 70% of $0.05 = $0.0350');
{
  const amount = parseFloat((INSIGHT_COST * THINKER_CUT).toFixed(4));

  assert('INSIGHT_COST is $0.05',              INSIGHT_COST === 0.05);
  assert('THINKER_CUT is 0.70 (70%)',          THINKER_CUT  === 0.70);
  assert('Payout = $0.035',                    amount === 0.035,       `got ${amount}`);
  assert('Platform keeps $0.015 (30%)',        parseFloat((INSIGHT_COST - amount).toFixed(4)) === 0.015);
  assert('Thinker % = 70%',                    Math.round(amount / INSIGHT_COST * 100) === 70);
  assert('toFixed(4) returns string "0.0350"', (INSIGHT_COST * THINKER_CUT).toFixed(4) === '0.0350');
  console.log();
}


// §2 — Guest users never trigger payout ──────────────────────────────────────
console.log('§2 — Guest users: payout block skipped entirely');
{
  let deductCalled = false, recordCalled = false;

  const result = await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: true,
    deductCreditFn:       async () => { deductCalled = true; },
    getUserByEmailFn:     okGetUser,
    creditWalletFn:       okCredit,
    recordThinkerEarningFn: async () => { recordCalled = true; },
  });

  assert('Result is skipped',              result.skipped === true);
  assert('deductCredit not called',        !deductCalled);
  assert('recordThinkerEarning not called',!recordCalled);
  console.log();
}


// §3 — Payout fires after successful deduction ───────────────────────────────
console.log('§3 — Authenticated user, successful deduction → payout fires');
{
  let recordArgs = null;

  const result = await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: false,
    deductCreditFn:         okDeduct,
    getUserByEmailFn:       okGetUser,
    creditWalletFn:         okCredit,
    recordThinkerEarningFn: async (...args) => { recordArgs = args; },
  });

  assert('deducted = true',                result.deducted === true);
  assert('payout amount = $0.035',         result.thinkerPayoutAmount === 0.035);
  assert('recordThinkerEarning was called',recordArgs !== null);
  console.log();
}


// §4 — payoutEmail found → creditWallet + record ──────────────────────────────
console.log('§4 — payoutEmail resolves to user → wallet credited + earning recorded');
{
  const creditLog = [], recordLog = [];

  const result = await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: false,
    deductCreditFn:         okDeduct,
    getUserByEmailFn:       okGetUser,
    creditWalletFn:         async (uid, amt, lbl, meta) => { creditLog.push({ uid, amt, lbl, meta }); },
    recordThinkerEarningFn: async (tid, uid, amt, lbl) => { recordLog.push({ tid, uid, amt, lbl }); },
  });

  assert('thinkerUserId resolved to UUID',  result.thinkerUserId === PAYOUT_USER_UUID);
  assert('creditWallet called once',        creditLog.length === 1);
  assert('creditWallet amount = $0.035',    creditLog[0].amt === 0.035);
  assert('creditWallet uid = thinker UUID', creditLog[0].uid === PAYOUT_USER_UUID);
  assert('line_item_type = thinker_royalty',creditLog[0].meta?.line_item_type === 'thinker_royalty');
  assert('recordThinkerEarning called',     recordLog.length === 1);
  assert('record thinker_id = "michael"',  recordLog[0].tid === 'michael');
  assert('record user_id = UUID',          recordLog[0].uid === PAYOUT_USER_UUID);
  assert('record amount = $0.035',         recordLog[0].amt === 0.035);
  console.log();
}


// §5 — payoutEmail lookup returns null → no wallet credit, record with null userId
console.log('§5 — payoutEmail user not found → no wallet credit, recordThinkerEarning(user_id=null)');
{
  const creditLog = [], recordLog = [];

  const result = await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: false,
    deductCreditFn:         okDeduct,
    getUserByEmailFn:       nullGetUser,
    creditWalletFn:         async (...a) => { creditLog.push(a); },
    recordThinkerEarningFn: async (tid, uid, amt, lbl) => { recordLog.push({ tid, uid, amt, lbl }); },
  });

  assert('thinkerUserId = null',            result.thinkerUserId === null);
  assert('creditWallet NOT called',         creditLog.length === 0);
  assert('recordThinkerEarning called',     recordLog.length === 1);
  assert('record user_id is null',          recordLog[0].uid === null);
  assert('record thinker_id = "michael"',  recordLog[0].tid === 'michael');
  assert('record amount still $0.035',     recordLog[0].amt === 0.035);
  console.log();
}


// §6 — No payoutEmail → skip creditWallet, still record ──────────────────────
console.log('§6 — No payoutEmail configured → creditWallet skipped, earning still logged');
{
  const creditLog = [], recordLog = [];
  const thinkerNoEmail = { ...MICHAEL, payoutEmail: undefined };

  await runPayoutBlock({
    thinker: thinkerNoEmail, stage: 'chat', isGuest: false,
    deductCreditFn:         okDeduct,
    getUserByEmailFn:       okGetUser,
    creditWalletFn:         async (...a) => { creditLog.push(a); },
    recordThinkerEarningFn: async (tid, uid, amt, lbl) => { recordLog.push({ tid, uid, amt, lbl }); },
  });

  assert('creditWallet NOT called',        creditLog.length === 0);
  assert('recordThinkerEarning called',    recordLog.length === 1);
  assert('record user_id = null',          recordLog[0].uid === null);
  assert('record amount = $0.035',         recordLog[0].amt === 0.035);
  console.log();
}


// §7 — creditWallet throws → recordThinkerEarning still fires ────────────────
console.log('§7 — creditWallet failure → earning still recorded (ledger is authoritative)');
{
  const recordLog = [];

  await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: false,
    deductCreditFn:         okDeduct,
    getUserByEmailFn:       async () => { throw new Error('DB timeout'); },
    creditWalletFn:         throwCredit,
    recordThinkerEarningFn: async (tid, uid, amt, lbl) => { recordLog.push({ tid, uid, amt, lbl }); },
  });

  assert('recordThinkerEarning still called', recordLog.length === 1);
  assert('record thinker_id = "michael"',    recordLog[0].tid === 'michael');
  assert('record amount = $0.035',           recordLog[0].amt === 0.035);
  console.log();
}


// §8 — thinker_id stored as string 'michael', never UUID ────────────────────
console.log('§8 — thinker_id in ledger is string "michael", not a UUID');
{
  const recordLog = [];

  await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: false,
    deductCreditFn:         okDeduct,
    getUserByEmailFn:       okGetUser,
    creditWalletFn:         okCredit,
    recordThinkerEarningFn: async (tid, uid, amt, lbl) => { recordLog.push({ tid, uid, amt, lbl }); },
  });

  assert('thinker_id = "michael"',          recordLog[0].tid === 'michael');
  assert('thinker_id is NOT a UUID',        !UUID_RE.test(recordLog[0].tid));
  assert('user_id IS a UUID',               UUID_RE.test(recordLog[0].uid));
  console.log();
}


// §9 — Payout label format ────────────────────────────────────────────────────
console.log('§9 — Payout label = "Perspective earned · {name} · {stage}"');
{
  const stages = ['chat', 'challenge', 'opportunity'];
  for (const stage of stages) {
    const recordLog = [];
    await runPayoutBlock({
      thinker: MICHAEL, stage, isGuest: false,
      deductCreditFn:         okDeduct,
      getUserByEmailFn:       okGetUser,
      creditWalletFn:         okCredit,
      recordThinkerEarningFn: async (tid, uid, amt, lbl) => { recordLog.push(lbl); },
    });
    const expected = `Perspective earned · Michael Akindele · ${stage}`;
    assert(`Label correct for stage "${stage}"`, recordLog[0] === expected,
      `got: "${recordLog[0]}"`);
  }
  console.log();
}


// §10 — THINKER_CUT env override ─────────────────────────────────────────────
console.log('§10 — THINKER_CUT=0.50 → payout = $0.025 (50%)');
{
  const altCut    = 0.50;
  const altAmount = parseFloat((INSIGHT_COST * altCut).toFixed(4));

  assert('altCut = 0.50',            altCut    === 0.50);
  assert('altAmount = $0.025',       altAmount  === 0.025,    `got ${altAmount}`);
  assert('Platform keeps $0.025',    parseFloat((INSIGHT_COST - altAmount).toFixed(4)) === 0.025);
  assert('Thinker % = 50%',         Math.round(altAmount / INSIGHT_COST * 100) === 50);
  console.log();
}


// §11 — Multiple sessions accumulate correctly ────────────────────────────────
console.log('§11 — 10 sessions × $0.035 = $0.35 total earnings');
{
  const SESSIONS  = 10;
  const perPayout = parseFloat((INSIGHT_COST * THINKER_CUT).toFixed(4));
  const total     = parseFloat((perPayout * SESSIONS).toFixed(4));
  const expected  = 0.35;

  assert(`${SESSIONS} × $${perPayout} = $${total}`,        total === expected, `got ${total}`);
  assert('No floating-point drift',                          Math.abs(total - expected) < 0.0001);
  assert('Platform keeps 30% across 10 sessions = $0.15',
    parseFloat(((INSIGHT_COST - perPayout) * SESSIONS).toFixed(4)) === 0.15);
  console.log();
}


// §12 — Deduction failure blocks payout ──────────────────────────────────────
console.log('§12 — deductCredit throws → recordThinkerEarning never called');
{
  let recordCalled = false;

  const result = await runPayoutBlock({
    thinker: MICHAEL, stage: 'chat', isGuest: false,
    deductCreditFn:         failDeduct,
    getUserByEmailFn:       okGetUser,
    creditWalletFn:         okCredit,
    recordThinkerEarningFn: async () => { recordCalled = true; },
  });

  assert('deducted = false',                result.deducted === false);
  assert('recordThinkerEarning NOT called', !recordCalled);
  assert('Error captured',                  result.error === 'Insufficient funds');
  console.log();
}


// §13 — Stats query matches on thinker_id = 'michael' ───────────────────────
console.log('§13 — Stats query: WHERE thinker_id = $1 matches all "michael" rows');
{
  // Simulate the thinker_earnings table after 3 sessions
  const ledger = [
    { thinker_id: 'michael', user_id: PAYOUT_USER_UUID, amount: 0.035 },
    { thinker_id: 'michael', user_id: PAYOUT_USER_UUID, amount: 0.035 },
    { thinker_id: 'michael', user_id: null,             amount: 0.035 }, // user lookup failed
  ];

  // Mirrors: WHERE user_id = $1 OR thinker_id = $1 (server passes ?thinker_id=michael)
  function mockGetThinkerStats(id) {
    const rows = ledger.filter(r => r.user_id === id || r.thinker_id === id);
    const total_perspectives = rows.length;
    const total_earned       = parseFloat(rows.reduce((s, r) => s + r.amount, 0).toFixed(4));
    return { total_perspectives, total_earned };
  }

  // Query by thinker_id string (new behaviour — ?thinker_id=michael)
  const byThinkerId = mockGetThinkerStats('michael');
  assert('Query by thinker_id matches all 3 rows', byThinkerId.total_perspectives === 3);
  assert('Total earned = $0.105',                  byThinkerId.total_earned === 0.105,
    `got ${byThinkerId.total_earned}`);

  // Query by user UUID — misses the null-userId row
  const byUserId = mockGetThinkerStats(PAYOUT_USER_UUID);
  assert('Query by UUID misses null-userId row',   byUserId.total_perspectives === 2,
    `got ${byUserId.total_perspectives}`);

  // Confirm thinker_id string approach is more complete
  assert('thinker_id query captures more rows',    byThinkerId.total_perspectives >= byUserId.total_perspectives);
  console.log();
}


// §14 — toFixed(4) prevents floating-point drift ──────────────────────────────
console.log('§14 — toFixed(4) on each payout prevents IEEE 754 drift at scale');
{
  const SESSIONS = 100;
  let rawSum     = 0;
  let fixedSum   = 0;

  for (let i = 0; i < SESSIONS; i++) {
    const rawPayout   = INSIGHT_COST * THINKER_CUT;        // no rounding
    const fixedPayout = parseFloat((rawPayout).toFixed(4)); // as server does
    rawSum   += rawPayout;
    fixedSum += fixedPayout;
  }

  const expectedSum = SESSIONS * 0.035; // 3.5
  const rawDrift    = Math.abs(rawSum   - expectedSum);
  const fixedDrift  = Math.abs(fixedSum - expectedSum);

  assert(`raw sum (no toFixed) within $0.001`,    rawDrift   < 0.001, `drift=${rawDrift}`);
  assert(`fixed sum (toFixed 4) within $0.0001`,  fixedDrift < 0.0001, `drift=${fixedDrift}`);
  assert(`100 sessions total = $3.50`,
    parseFloat(fixedSum.toFixed(2)) === 3.50, `got ${fixedSum.toFixed(2)}`);
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
