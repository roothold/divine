-- seed-admin.sql
-- Creates Michael Akindele as admin with Thinker Access.
-- Run ONCE after schema.sql:
--   psql $DATABASE_URL -f seed-admin.sql
--
-- When Michael logs in via Google with michael@uncharted.ventures,
-- the OAuth upsert will link his google_id to this row automatically.

INSERT INTO users (email, name, role, thinker_access, thinker_id)
VALUES (
  'michael@uncharted.ventures',
  'Michael Akindele',
  'admin',
  TRUE,
  'michael'
)
ON CONFLICT (email) DO UPDATE
  SET role           = 'admin',
      thinker_access = TRUE,
      thinker_id     = 'michael',
      updated_at     = NOW();

-- Verify
SELECT id, email, name, role, thinker_access, thinker_id, created_at
FROM users WHERE email = 'michael@uncharted.ventures';
