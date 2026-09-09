const { Pool } = require('pg');

// Any hosted Postgres (Supabase, Render, Neon, Railway, ...) requires SSL;
// only plain localhost/127.0.0.1 (local dev) skips it.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sheets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      translation TEXT NOT NULL DEFAULT '',
      definition TEXT NOT NULL DEFAULT '',
      image_url TEXT,
      definition_color TEXT,
      level INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      collapsed BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_sheet_parent ON nodes(sheet_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_sheet_root ON nodes(sheet_id) WHERE parent_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_nodes_search ON nodes(sheet_id, name, translation);

    CREATE TABLE IF NOT EXISTS drawings (
      id TEXT PRIMARY KEY,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      color TEXT NOT NULL,
      size INTEGER NOT NULL,
      points JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drawings_sheet ON drawings(sheet_id);

    CREATE TABLE IF NOT EXISTS texts (
      id TEXT PRIMARY KEY,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      x REAL NOT NULL,
      y REAL NOT NULL,
      w REAL NOT NULL,
      h REAL NOT NULL,
      color TEXT NOT NULL,
      size INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_texts_sheet ON texts(sheet_id);
  `);

  // Earlier versions stored images as base64 directly in the row (image_data).
  // Rename to image_url now that images live in Supabase Storage instead --
  // guarded so it's a no-op on a fresh database or one already migrated.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='nodes' AND column_name='image_data')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='nodes' AND column_name='image_url') THEN
        ALTER TABLE nodes RENAME COLUMN image_data TO image_url;
      END IF;
    END $$;
  `);

  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS definition_color TEXT;`);

  // Powers the "find which category this belongs in" search: trigram
  // indexes let a query match close-but-not-exact wording (typos, slightly
  // different phrasing) in addition to plain substring matches -- no
  // external API/cost, just built-in Postgres. Guarded because a locked
  // -down host might not allow CREATE EXTENSION; the app still works with
  // plain ILIKE search if this fails.
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX IF NOT EXISTS idx_nodes_name_trgm ON nodes USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_nodes_translation_trgm ON nodes USING gin (translation gin_trgm_ops);
    `);
  } catch (err) {
    console.warn('pg_trgm not available -- falling back to plain substring search:', err.message);
  }
}

module.exports = { pool, migrate };
