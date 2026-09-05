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
      image_data TEXT,
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
}

module.exports = { pool, migrate };
