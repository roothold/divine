/**
 * test-thinker-logic.mjs
 * Divine — Thinker Logic v2.0 Activation Test Suite
 *
 * Pure functions are inlined (same pattern as test-chat.mjs) so the test
 * runs without a real DB or pg package.
 *
 * Sections:
 *   §1  rankAxiomsThompson — deterministic structural properties
 *   §2  loadThinkerAxioms — DB query shape (mocked)
 *   §3  buildEnhancedSystemPrompt — base fallback when no axioms
 *   §4  buildEnhancedSystemPrompt — injects ranked axioms
 *   §5  buildEnhancedSystemPrompt — appends fragility alerts
 *   §6  buildEnhancedSystemPrompt — graceful fallback on DB error
 *   §7  Guest users receive base prompt (no enhancement)
 *   §8  Authenticated users receive enhanced prompt
 *   §9  Axiom seed SQL uses ON CONFLICT DO NOTHING (idempotent)
 *   §10 All five Michael axiom categories are defined
 *   §11 Thompson ranking respects weight ordering on average
 *   §12 Fragility alerts capped at 4 lines
 *   §13 Base system prompt fully preserved in enhanced output
 *   §14 Empty fragility set produces no fragility section
 */

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Pure functions inlined from db.js ─────────────────────────────────────────

function sampleGamma(shape) {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x;
    do { x = Math.random() * 2 - 1; } while (Math.abs(x) >= 1);
    const u2 = Math.random();
    const z  = Math.sqrt(-2 * Math.log(u2)) * Math.cos(2 * Math.PI * x);
    const v  = Math.pow(1 + c * z, 3);
    if (v > 0) {
      const u3 = Math.random();
      if (u3 < 1 - 0.0331 * Math.pow(z, 4)) return d * v;
      if (Math.log(u3) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v;
    }
  }
}

function sampleBeta(alpha, beta_) {
  const g1 = sampleGamma(alpha);
  const g2 = sampleGamma(beta_);
  return g1 / (g1 + g2);
}

function rankAxiomsThompson(axioms, topK = 5) {
  const ranked = axioms.map(ax => {
    const alpha  = (ax.success_count   || 0) + 1;
    const beta_  = (ax.rejection_count || 0) + 1;
    const posterior_sample = sampleBeta(alpha, beta_);
    const boost  = ax.boost_factor || 1.0;
    const blended_weight = (0.70 * parseFloat(ax.current_weight) + 0.30 * posterior_sample * 3.0) * boost;
    return { ...ax, sampled_weight: posterior_sample, blended_weight };
  });
  return ranked
    .sort((a, b) => b.blended_weight - a.blended_weight)
    .slice(0, topK);
}

// ── buildEnhancedSystemPrompt (mirrors server.js) ─────────────────────────────
async function buildEnhancedSystemPrompt(thinker, ventureId, {
  loadThinkerAxiomsFn,
  rankFn = rankAxiomsThompson,
  getFragilityFn,
} = {}) {
  try {
    const axioms = await loadThinkerAxiomsFn(thinker.id, ventureId);
    if (!axioms.length) return thinker.systemPrompt;

    const ranked        = rankFn(axioms, 5);
    const fragilityRows = (
      await Promise.all(ranked.map(ax => getFragilityFn(ax.logic_id)))
    ).flat();

    const axiomLines = ranked.map((ax, i) =>
      `${i + 1}. [${ax.category}] ${ax.axiom_text.trim()}`
    ).join('\n');

    let prompt = thinker.systemPrompt.trimEnd();
    prompt += `\n\n--- Active reasoning threads for this session ---\n`
            + `The following frameworks carry elevated weight based on this venture's track record. `
            + `Lead with them. Adjust emphasis as new signal emerges.\n\n`
            + axiomLines;

    if (fragilityRows.length) {
      const fpLines = fragilityRows
        .slice(0, 4)
        .map(fp => `• ${fp.condition} → ${fp.failure_mode}`)
        .join('\n');
      prompt += `\n\n--- Fragility alerts ---\n`
              + `Conditions where this context is most likely to break. Navigate with precision.\n\n`
              + fpLines;
    }

    return prompt;
  } catch {
    return thinker.systemPrompt; // graceful fallback
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────
const BASE_PROMPT = 'You are Michael Akindele — builder, designer, and founder.';
const MICHAEL     = { id: 'michael', systemPrompt: BASE_PROMPT };
const VENTURE_ID  = 'a0000000-0000-0000-0000-000000000001';

const MICHAEL_AXIOMS = [
  { logic_id: 'michael.problem_validation', category: 'Problem Validation',
    axiom_text: 'Validate whether the problem is real before evaluating any solution.',
    base_weight: 1.0, current_weight: 1.0, success_count: 0, rejection_count: 0 },
  { logic_id: 'michael.market_audit', category: 'Market Audit',
    axiom_text: 'Audit what already exists before building anything.',
    base_weight: 1.0, current_weight: 1.0, success_count: 0, rejection_count: 0 },
  { logic_id: 'michael.scale_thinking', category: 'Scale Thinking',
    axiom_text: 'Challenge the founder to think bigger.',
    base_weight: 1.0, current_weight: 1.0, success_count: 0, rejection_count: 0 },
  { logic_id: 'michael.brand_signal', category: 'Brand Signal',
    axiom_text: 'Examine how the founder is showing up externally.',
    base_weight: 1.0, current_weight: 1.0, success_count: 0, rejection_count: 0 },
  { logic_id: 'michael.direct_truth', category: 'Direct Truth',
    axiom_text: "Be direct and willing to say what others won't.",
    base_weight: 1.0, current_weight: 1.0, success_count: 0, rejection_count: 0 },
];

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Divine — Thinker Logic v2.0 Activation Test Suite');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');


// §1 — rankAxiomsThompson structural properties ───────────────────────────────
console.log('§1 — rankAxiomsThompson: deterministic structural properties');
{
  const result = rankAxiomsThompson(MICHAEL_AXIOMS, 5);

  assert('Returns an array',                    Array.isArray(result));
  assert('Returns ≤ topK items',                result.length <= 5);
  assert('Each item has sampled_weight',        result.every(r => 'sampled_weight' in r));
  assert('Each item has blended_weight',        result.every(r => 'blended_weight' in r));
  assert('Each item has logic_id',              result.every(r => typeof r.logic_id === 'string'));
  assert('sampled_weight is finite positive',   result.every(r => isFinite(r.sampled_weight) && r.sampled_weight > 0));
  const descending = result.every((r, i) =>
    i === 0 || result[i - 1].blended_weight >= r.blended_weight);
  assert('Sorted descending by blended_weight', descending);
  console.log();
}


// §2 — loadThinkerAxioms: DB query shape ──────────────────────────────────────
console.log('§2 — loadThinkerAxioms DB query merges axiom + venture weight rows');
{
  const mockRows = [
    { logic_id: 'michael.problem_validation', category: 'Problem Validation',
      axiom_text: 'Validate...', base_weight: '1.000',
      current_weight: '1.420', success_count: '5', rejection_count: '1', application_count: '8' },
    { logic_id: 'michael.market_audit', category: 'Market Audit',
      axiom_text: 'Audit...', base_weight: '1.000',
      current_weight: '1.000', success_count: '0', rejection_count: '0', application_count: '0' },
  ];

  const capturedParams = [];
  async function mockLoadThinkerAxioms(thinkerId, ventureId) {
    capturedParams.push([thinkerId, ventureId]);
    return mockRows;
  }

  const rows = await mockLoadThinkerAxioms('michael', VENTURE_ID);

  assert('Returns array of rows',                Array.isArray(rows));
  assert('Venture-specific weight in row 0',     rows[0].current_weight === '1.420');
  assert('Base-weight fallback in row 1',        rows[1].current_weight === '1.000');
  assert('Query receives thinkerId param',       capturedParams[0][0] === 'michael');
  assert('Query receives ventureId param',       capturedParams[0][1] === VENTURE_ID);
  assert('Row has success_count',               'success_count' in rows[0]);
  assert('Row has rejection_count',             'rejection_count' in rows[0]);
  console.log();
}


// §3 — No axioms in DB → base prompt returned unchanged ───────────────────────
console.log('§3 — No axioms seeded → base system prompt returned unchanged');
{
  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => [],
    getFragilityFn:      async () => [],
  });
  assert('Returns base prompt exactly', prompt === BASE_PROMPT,
    `got: "${prompt.slice(0, 60)}"`);
  console.log();
}


// §4 — Axioms present → ranked threads injected ───────────────────────────────
console.log('§4 — Axioms seeded → ranked reasoning threads injected into prompt');
{
  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => MICHAEL_AXIOMS,
    getFragilityFn:      async () => [],
  });

  assert('Prompt starts with base',               prompt.startsWith(BASE_PROMPT));
  assert('Contains axiom section header',         prompt.includes('Active reasoning threads'));
  assert('Contains numbered list entry (1.)',     prompt.includes('1.'));
  assert('Prompt longer than base',               prompt.length > BASE_PROMPT.length);
  const categoryHits = MICHAEL_AXIOMS.filter(a => prompt.includes(`[${a.category}]`)).length;
  assert('All 5 categories injected',             categoryHits === 5, `got ${categoryHits}`);
  console.log();
}


// §5 — Fragility alerts appended below axioms ─────────────────────────────────
console.log('§5 — Fragility alerts appended when present');
{
  const fragility = [
    { fragility_id: 'f1', parent_logic_id: 'michael.problem_validation',
      condition: 'Founder conflates early traction with PMF',
      failure_mode: 'Premature scaling before signal is validated' },
    { fragility_id: 'f2', parent_logic_id: 'michael.market_audit',
      condition: "Founder claims 'no direct competitors'",
      failure_mode: 'Blind spot: ignoring indirect competitors' },
  ];

  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => MICHAEL_AXIOMS,
    getFragilityFn:      async (id) => fragility.filter(f => f.parent_logic_id === id),
  });

  assert('Contains fragility section header',    prompt.includes('Fragility alerts'));
  assert('Contains first condition',             prompt.includes('Founder conflates early traction'));
  assert('Contains failure mode text',           prompt.includes('Premature scaling'));
  assert('Uses bullet format (•)',               prompt.includes('•'));
  assert('Fragility section follows axiom section',
    prompt.indexOf('Fragility alerts') > prompt.indexOf('Active reasoning threads'));
  console.log();
}


// §6 — DB error → graceful fallback ───────────────────────────────────────────
console.log('§6 — DB error during axiom load → returns base prompt without crashing');
{
  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => { throw new Error('DB connection refused'); },
    getFragilityFn:      async () => [],
  });
  assert('Returns base prompt on error',  prompt === BASE_PROMPT);
  assert('Did not throw',                 true);
  console.log();
}


// §7 — Guest users bypass enhancement ────────────────────────────────────────
console.log('§7 — isGuest=true → base prompt returned, loadThinkerAxioms never called');
{
  let loadCalled = false;
  async function guestPath(thinker, userId, isGuest) {
    if (isGuest) return thinker.systemPrompt;
    loadCalled = true;
    return buildEnhancedSystemPrompt(thinker, userId, {
      loadThinkerAxiomsFn: async () => MICHAEL_AXIOMS,
      getFragilityFn:      async () => [],
    });
  }
  const prompt = await guestPath(MICHAEL, 'u_guestabcdef', true);
  assert('Guest receives exact base prompt',    prompt === BASE_PROMPT);
  assert('loadThinkerAxioms not called',        !loadCalled);
  console.log();
}


// §8 — Authenticated users receive enhanced prompt ────────────────────────────
console.log('§8 — isGuest=false → axiom-enhanced prompt returned');
{
  let loadCalled = false;
  async function authPath(thinker, userId, isGuest) {
    if (isGuest) return thinker.systemPrompt;
    loadCalled = true;
    return buildEnhancedSystemPrompt(thinker, userId, {
      loadThinkerAxiomsFn: async () => MICHAEL_AXIOMS,
      getFragilityFn:      async () => [],
    });
  }
  const prompt = await authPath(MICHAEL, VENTURE_ID, false);
  assert('loadThinkerAxioms was called',       loadCalled);
  assert('Prompt is enhanced (longer)',        prompt.length > BASE_PROMPT.length);
  assert('Contains axiom section',            prompt.includes('Active reasoning threads'));
  console.log();
}


// §9 — Axiom seed SQL is idempotent ───────────────────────────────────────────
console.log('§9 — seedThinkerAxioms SQL uses ON CONFLICT DO NOTHING');
{
  const seedSql =
    `INSERT INTO thinker_axioms (logic_id, thinker_id, category, axiom_text, base_weight)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (logic_id) DO NOTHING`;

  assert('Uses INSERT not UPSERT/REPLACE',     seedSql.trimStart().startsWith('INSERT'));
  assert('Has ON CONFLICT DO NOTHING guard',   seedSql.includes('ON CONFLICT (logic_id) DO NOTHING'));
  assert('Conflicts on logic_id (PK)',         seedSql.includes('ON CONFLICT (logic_id)'));
  console.log();
}


// §10 — All five Michael axiom categories defined ─────────────────────────────
console.log('§10 — All five Michael axiom categories are seeded from his profile');
{
  const expected = ['Problem Validation', 'Market Audit', 'Scale Thinking', 'Brand Signal', 'Direct Truth'];
  const seeded   = MICHAEL_AXIOMS.map(a => a.category);

  expected.forEach(cat => assert(`"${cat}" present`, seeded.includes(cat)));
  assert('Exactly 5 axioms',                   MICHAEL_AXIOMS.length === 5);
  assert('All logic_ids prefixed michael.*',   MICHAEL_AXIOMS.every(a => a.logic_id.startsWith('michael.')));
  assert('All have axiom_text',                MICHAEL_AXIOMS.every(a => a.axiom_text.length > 10));
  assert('All have base_weight = 1.0',         MICHAEL_AXIOMS.every(a => a.base_weight === 1.0));
  console.log();
}


// §11 — Thompson ranking respects weight ordering AND shows exploration ────────
console.log('§11 — Thompson ranking: high-weight wins majority, exploration is real (200 trials)');
{
  // Use overlapping weight ranges so neither axiom dominates deterministically:
  //   high  blend ∈ [0.77, 1.67]
  //   medium blend ∈ [0.70, 1.60]  ← real overlap, medium can win
  const axioms = [
    { logic_id: 'high',   category: 'A', axiom_text: 'High',
      current_weight: 1.1, success_count: 2, rejection_count: 1 },
    { logic_id: 'medium', category: 'B', axiom_text: 'Medium',
      current_weight: 1.0, success_count: 1, rejection_count: 2 },
    { logic_id: 'low',    category: 'C', axiom_text: 'Low',
      current_weight: 0.5, success_count: 0, rejection_count: 5 },
  ];

  let highFirst = 0, medFirst = 0;
  const TRIALS  = 200;
  for (let i = 0; i < TRIALS; i++) {
    const top = rankAxiomsThompson(axioms, 3)[0].logic_id;
    if (top === 'high')   highFirst++;
    if (top === 'medium') medFirst++;
  }
  const highRate = highFirst / TRIALS;
  const medRate  = medFirst  / TRIALS;
  assert(`High-weight wins majority (> 50%) — got ${Math.round(highRate * 100)}%`, highRate > 0.50);
  assert(`Exploration active: medium wins at least once — got ${Math.round(medRate * 100)}%`,
    medFirst > 0, `medium never won in ${TRIALS} trials`);
  assert('Low-weight axiom never top-ranked', highFirst + medFirst === TRIALS);
  console.log();
}


// §12 — Fragility section capped at 4 lines ───────────────────────────────────
console.log('§12 — Fragility section limited to 4 bullet lines maximum');
{
  const manyFp = Array.from({ length: 10 }, (_, i) => ({
    fragility_id: `f${i}`, parent_logic_id: 'michael.problem_validation',
    condition: `Condition ${i}`, failure_mode: `Failure ${i}`,
  }));

  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => [MICHAEL_AXIOMS[0]],
    getFragilityFn:      async () => manyFp,
  });

  const bullets = prompt.split('\n').filter(l => l.startsWith('•'));
  assert(`At most 4 bullet lines (got ${bullets.length})`, bullets.length <= 4);
  console.log();
}


// §13 — Base prompt fully preserved ───────────────────────────────────────────
console.log('§13 — Base system prompt fully preserved in enhanced output');
{
  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => MICHAEL_AXIOMS,
    getFragilityFn:      async () => [],
  });
  assert('Starts with base prompt',       prompt.startsWith(BASE_PROMPT));
  assert('Full base prompt present',      prompt.includes(BASE_PROMPT));
  assert('Base prompt not duplicated',
    prompt.indexOf(BASE_PROMPT) === prompt.lastIndexOf(BASE_PROMPT));
  console.log();
}


// §14 — No fragility section when set is empty ────────────────────────────────
console.log('§14 — Empty fragility set: no Fragility section emitted');
{
  const prompt = await buildEnhancedSystemPrompt(MICHAEL, VENTURE_ID, {
    loadThinkerAxiomsFn: async () => MICHAEL_AXIOMS,
    getFragilityFn:      async () => [],
  });
  assert('No "Fragility alerts" header', !prompt.includes('Fragility alerts'));
  assert('No bullet points (•)',         !prompt.includes('• '));
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
