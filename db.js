// db.js — Supabase (hosted Postgres) client + small helper functions.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (or, for the
// GitHub Actions workflow, as repo secrets). The service role key bypasses
// row-level security — fine here since this app has exactly one user (you)
// and the key never reaches the browser, only your own server/script.
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set yet — set them in .env ' +
      '(see README) before liked-movie / services calls will work.'
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder'
);

function must(result, context) {
  if (result.error) {
    throw new Error(`[db] ${context}: ${result.error.message}`);
  }
  return result.data;
}

module.exports = { supabase, must };
