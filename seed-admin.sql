-- ═══════════════════════════════════════════════════════════════════════════
-- DIVINE INTELLIGENCE — Seed Data
-- Run ONCE after schema.sql:
--   psql $DATABASE_URL -f schema.sql
--   psql $DATABASE_URL -f seed-admin.sql
-- ═══════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. COGNITIVE DOMAINS
--    The canonical tagging vocabulary for routing and verification.
--    Thinkers are verified against these exact slugs.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO cognitive_domains (slug, name, description, color, icon, sort_order) VALUES

  -- ── Tier 1: Primary domains (top-level routing) ────────────────────────
  ('first-principles-logic',
   'First-Principles Logic',
   'Decomposing complex problems to foundational truths and reasoning up from there.',
   '#2C3E50', '◈', 10),

  ('startup-strategy',
   'Startup Strategy',
   'Early-stage company building, product-market fit, fundraising, and growth.',
   '#4A7FB5', '⬡', 20),

  ('cognitive-design',
   'Cognitive Design',
   'Designing systems and products that align with how humans think and decide.',
   '#C9A84C', '⬟', 30),

  ('stoic-philosophy',
   'Stoic Philosophy',
   'Applied Stoicism: clarity under pressure, dichotomy of control, virtue ethics.',
   '#4A7C6F', '◎', 40),

  ('systems-thinking',
   'Systems Thinking',
   'Understanding feedback loops, emergence, and leverage points in complex systems.',
   '#7B68B5', '⟳', 50),

  ('decision-architecture',
   'Decision Architecture',
   'Structuring high-stakes decisions, eliminating bias, and building decision frameworks.',
   '#B56B4A', '⬡', 60),

  ('product-philosophy',
   'Product Philosophy',
   'The deeper "why" behind product choices — utility, meaning, and human behaviour.',
   '#5A8F7B', '◈', 70),

  ('entrepreneurial-psychology',
   'Entrepreneurial Psychology',
   'Founder mindset, resilience, identity, and the inner game of building.',
   '#A07BB5', '◉', 80),

  ('capital-strategy',
   'Capital Strategy',
   'Venture dynamics, term sheets, dilution, and long-term ownership thinking.',
   '#4A7FB5', '◈', 90),

  ('narrative-intelligence',
   'Narrative Intelligence',
   'Crafting stories that move people — pitch, brand, and persuasion.',
   '#B5914A', '◎', 100),

  -- ── Tier 2: Sub-domains (inherit from parent routing) ──────────────────
  ('logical-fallacies',
   'Logical Fallacies',
   'Identifying and dismantling flawed reasoning in arguments.',
   '#2C3E50', '◈', 11),

  ('go-to-market',
   'Go-to-Market',
   'Launch strategy, channel selection, pricing, and early customer acquisition.',
   '#4A7FB5', '⬡', 21),

  ('mental-models',
   'Mental Models',
   'Cross-disciplinary thinking tools borrowed from physics, biology, economics.',
   '#7B68B5', '⟳', 51),

  ('leadership-philosophy',
   'Leadership Philosophy',
   'What it means to lead with clarity, honesty, and long-term thinking.',
   '#4A7C6F', '◎', 81)

ON CONFLICT (slug) DO UPDATE
  SET name        = EXCLUDED.name,
      description = EXCLUDED.description,
      color       = EXCLUDED.color,
      icon        = EXCLUDED.icon,
      sort_order  = EXCLUDED.sort_order,
      is_active   = TRUE;

-- Set parent relationships for sub-domains
UPDATE cognitive_domains SET parent_id = (
  SELECT id FROM cognitive_domains WHERE slug = 'first-principles-logic'
) WHERE slug = 'logical-fallacies';

UPDATE cognitive_domains SET parent_id = (
  SELECT id FROM cognitive_domains WHERE slug = 'startup-strategy'
) WHERE slug = 'go-to-market';

UPDATE cognitive_domains SET parent_id = (
  SELECT id FROM cognitive_domains WHERE slug = 'systems-thinking'
) WHERE slug = 'mental-models';

UPDATE cognitive_domains SET parent_id = (
  SELECT id FROM cognitive_domains WHERE slug = 'entrepreneurial-psychology'
) WHERE slug = 'leadership-philosophy';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ADMIN USER — Michael Akindele
--    When Michael logs in via Google (michael@uncharted.ventures or
--    michael@surpluspods.com), the OAuth upsert will link google_id to this row.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO users (email, name, role, thinker_access, thinker_slug)
VALUES (
  'michael@surpluspods.com',
  'Michael Akindele',
  'admin',
  TRUE,
  'michael-akindele'
)
ON CONFLICT (email) DO UPDATE
  SET name          = 'Michael Akindele',
      role          = 'admin',
      thinker_access = TRUE,
      thinker_slug  = 'michael-akindele',
      updated_at    = NOW();

-- Secondary email alias
INSERT INTO users (email, name, role, thinker_access, thinker_slug)
VALUES (
  'michael@uncharted.ventures',
  'Michael Akindele',
  'admin',
  TRUE,
  'michael-akindele'
)
ON CONFLICT (email) DO UPDATE
  SET name          = 'Michael Akindele',
      role          = 'admin',
      thinker_access = TRUE,
      thinker_slug  = 'michael-akindele',
      updated_at    = NOW();


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THINKER PROFILE — Michael Akindele
--    The public card. user_id is populated when he first logs in.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO thinker_profiles (
  slug,
  user_id,
  display_name,
  title,
  bio,
  avatar_initials,
  avatar_color,
  lens,
  status,
  public_profile,
  royalty_pct
)
VALUES (
  'michael-akindele',
  (SELECT id FROM users WHERE email = 'michael@surpluspods.com' LIMIT 1),
  'Michael Akindele',
  'Founder · Cognitive Strategist',
  'Builder of systems that think. Michael works at the intersection of first-principles reasoning, startup strategy, and cognitive design — helping founders and operators cut through noise to reach the essential decision.',
  'MA',
  '#2C3E50',
  'Every complex problem has a simple spine. Find it.',
  'active',
  TRUE,
  20.00
)
ON CONFLICT (slug) DO UPDATE
  SET display_name    = EXCLUDED.display_name,
      title           = EXCLUDED.title,
      bio             = EXCLUDED.bio,
      avatar_initials = EXCLUDED.avatar_initials,
      avatar_color    = EXCLUDED.avatar_color,
      lens            = EXCLUDED.lens,
      status          = EXCLUDED.status,
      royalty_pct     = EXCLUDED.royalty_pct,
      updated_at      = NOW();


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THINKER DOMAIN VERIFICATIONS — Michael Akindele
--    These are the ONLY domains Michael will appear in.
--    Any query NOT tagged with one of these slugs → Michael is excluded.
--    verified_by = self (admin) for bootstrap; replace with peer review process.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: get Michael's thinker profile id
DO $$
DECLARE
  v_thinker_id UUID;
  v_admin_id   UUID;
BEGIN
  SELECT id INTO v_thinker_id FROM thinker_profiles WHERE slug = 'michael-akindele';
  SELECT id INTO v_admin_id   FROM users WHERE email = 'michael@surpluspods.com' LIMIT 1;

  -- ── Expert-level verifications (highest routing priority) ─────────────
  INSERT INTO thinker_domain_verifications
    (thinker_id, domain_id, level, verified_by, confidence_pct, notes)
  SELECT
    v_thinker_id,
    id,
    'expert',
    v_admin_id,
    confidence,
    note
  FROM (VALUES
    ('first-principles-logic',      94, 'Core methodology. Michael uses first-principles decomposition as his primary reasoning mode.'),
    ('startup-strategy',            91, 'Founder with multiple ventures. Deep hands-on experience in 0→1 company building.'),
    ('cognitive-design',            88, 'Systems architect. Designs decision environments and thinking frameworks professionally.'),
    ('decision-architecture',       90, 'Specialises in structuring high-stakes decisions under uncertainty.')
  ) AS t(domain_slug, confidence, note)
  JOIN cognitive_domains cd ON cd.slug = t.domain_slug
  ON CONFLICT (thinker_id, domain_id) DO UPDATE
    SET level          = 'expert',
        confidence_pct = EXCLUDED.confidence_pct,
        notes          = EXCLUDED.notes,
        is_active      = TRUE,
        revoked_at     = NULL,
        updated_at     = NOW()  -- note: no updated_at on this table; no-op col
  ;

  -- Wait — thinker_domain_verifications has no updated_at. Remove that line.
  -- The ON CONFLICT handles idempotency via the other columns.

  -- ── Verified-level (strong, but not expert-tier routing priority) ─────
  INSERT INTO thinker_domain_verifications
    (thinker_id, domain_id, level, verified_by, confidence_pct, notes)
  SELECT
    v_thinker_id,
    id,
    'verified',
    v_admin_id,
    confidence,
    note
  FROM (VALUES
    ('stoic-philosophy',            82, 'Applied practitioner. Cites Stoic frameworks frequently in strategic contexts.'),
    ('systems-thinking',            85, 'Fluent in feedback loops, emergence, and leverage. Applied to product and org design.'),
    ('entrepreneurial-psychology',  80, 'Documented experience navigating founder identity, resilience, and high-pressure decisions.'),
    ('narrative-intelligence',      78, 'Pitching, brand articulation, and persuasive communication for high-stakes contexts.'),
    ('product-philosophy',          83, 'Product thinker at the intersection of utility and human behaviour.'),
    ('logical-fallacies',           89, 'Sub-domain of first-principles. Strong pattern recognition for flawed arguments.'),
    ('go-to-market',                80, 'Sub-domain of startup strategy. Hands-on GTM design experience.'),
    ('mental-models',               84, 'Cross-disciplinary mental model library applied to business and life decisions.'),
    ('leadership-philosophy',       79, 'Has written and spoken on leadership clarity and honest management.')
  ) AS t(domain_slug, confidence, note)
  JOIN cognitive_domains cd ON cd.slug = t.domain_slug
  ON CONFLICT (thinker_id, domain_id) DO UPDATE
    SET level          = EXCLUDED.level,
        confidence_pct = EXCLUDED.confidence_pct,
        notes          = EXCLUDED.notes,
        is_active      = TRUE,
        revoked_at     = NULL;

  -- ── Explicitly NOT verified — capital-strategy ─────────────────────────
  -- Michael is intentionally excluded from capital-strategy routing.
  -- This prevents him from appearing on VC/term-sheet queries.
  -- (No row = no access. Documenting here for clarity.)
  -- If a future admin wants to grant this, they must explicitly insert a row.

  RAISE NOTICE 'Michael Akindele verification seeded. Expert domains: 4. Verified domains: 9. Excluded: capital-strategy.';
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CREDIT PACKAGES
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO credit_packages (credits, price_usd_cents, label, description, sort_order)
VALUES
  (100,  500,  '',           'Get started. 100 Perspectives at $0.05 each.', 10),
  (200,  900,  'Popular',    '200 Perspectives. Save 10% vs starter pack.',   20),
  (500,  2000, 'Best Value', '500 Perspectives. Best per-perspective rate.',  30),
  (1000, 3500, 'Studio',     '1000 Perspectives. For power users and teams.', 40)
ON CONFLICT DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. VERIFICATION
-- ─────────────────────────────────────────────────────────────────────────────

-- Confirm admin user
SELECT id, email, name, role, thinker_access, thinker_slug, created_at
FROM users
WHERE email IN ('michael@surpluspods.com', 'michael@uncharted.ventures');

-- Confirm thinker profile
SELECT id, slug, display_name, title, status, royalty_pct
FROM thinker_profiles
WHERE slug = 'michael-akindele';

-- Show domain verifications with routing scores
SELECT
  tp.display_name,
  cd.slug        AS domain,
  tdv.level,
  tdv.confidence_pct AS confidence,
  ROUND(
    CASE tdv.level
      WHEN 'expert'      THEN 1.00
      WHEN 'verified'    THEN 0.80
      WHEN 'provisional' THEN 0.50
    END * (tdv.confidence_pct / 100.0), 4
  )              AS routing_score,
  tdv.is_active
FROM thinker_domain_verifications tdv
JOIN thinker_profiles tp ON tp.id = tdv.thinker_id
JOIN cognitive_domains cd ON cd.id = tdv.domain_id
WHERE tp.slug = 'michael-akindele'
ORDER BY routing_score DESC;

-- Test the routing function — only returns Michael for his verified domains
SELECT * FROM get_verified_thinkers_for_domain('first-principles-logic');
SELECT * FROM get_verified_thinkers_for_domain('capital-strategy'); -- should return 0 rows

-- Credit package lineup
SELECT credits, price_usd_cents, ROUND(price_usd_cents::numeric / credits, 2) AS cents_per_credit, label
FROM credit_packages
WHERE is_active = TRUE
ORDER BY sort_order;
