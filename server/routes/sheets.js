const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const ws = require('../ws');
const storage = require('../storage');

const patchRouter = require('../wrapAsync');
const router = patchRouter(express.Router());

function id() { return crypto.randomUUID(); }

router.get('/sheets', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, sort_order AS "sortOrder", color FROM sheets ORDER BY sort_order ASC');
  res.json(rows);
});

router.post('/sheets', async (req, res) => {
  const name = (req.body.name || 'ชีทใหม่').trim();
  const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM sheets');
  const sheet = { id: id(), name, sortOrder: rows[0].next, color: null };
  await pool.query('INSERT INTO sheets (id, name, sort_order) VALUES ($1, $2, $3)', [sheet.id, sheet.name, sheet.sortOrder]);
  ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:created', sheet });
  res.json(sheet);
});

router.post('/sheets/reorder', async (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  for (let i = 0; i < order.length; i++) {
    await pool.query('UPDATE sheets SET sort_order = $1 WHERE id = $2', [i, order[i]]);
  }
  ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:reordered', order });
  res.json({ ok: true });
});

router.patch('/sheets/:id', async (req, res) => {
  const sets = [];
  const params = [];
  let n = 1;
  const patch = {};
  if ('name' in req.body) {
    const name = (req.body.name || '').trim() || 'ไม่มีชื่อ';
    sets.push(`name = $${n++}`); params.push(name); patch.name = name;
  }
  if ('color' in req.body) {
    const color = req.body.color || null;
    sets.push(`color = $${n++}`); params.push(color); patch.color = color;
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(req.params.id);
  await pool.query(`UPDATE sheets SET ${sets.join(', ')} WHERE id = $${n}`, params);
  ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:updated', id: req.params.id, patch });
  res.json({ ok: true });
});

router.post('/sheets/:id/duplicate', async (req, res) => {
  const client = await pool.connect();
  try {
    const srcRes = await client.query('SELECT * FROM sheets WHERE id = $1', [req.params.id]);
    if (!srcRes.rows[0]) return res.status(404).json({ error: 'not_found' });
    const src = srcRes.rows[0];

    const nodesRes = await client.query('SELECT * FROM nodes WHERE sheet_id = $1', [req.params.id]);
    const drawingsRes = await client.query('SELECT * FROM drawings WHERE sheet_id = $1', [req.params.id]);
    const textsRes = await client.query('SELECT * FROM texts WHERE sheet_id = $1', [req.params.id]);

    const { rows: ordRows } = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM sheets');
    const newSheetId = id();
    const newSheetName = src.name + ' (สำเนา)';

    const idMap = new Map();
    nodesRes.rows.forEach((n) => idMap.set(n.id, id()));
    // Copy each image to its own file first (outside the transaction) so the
    // duplicated sheet doesn't share storage objects with the original --
    // deleting a node later would otherwise delete the other sheet's image too.
    const newImageUrls = new Map();
    await Promise.all(nodesRes.rows.map(async (n) => {
      if (n.image_url) newImageUrls.set(n.id, await storage.copyImage(n.image_url, idMap.get(n.id)));
    }));

    await client.query('BEGIN');
    await client.query('INSERT INTO sheets (id, name, sort_order, color) VALUES ($1, $2, $3, $4)', [newSheetId, newSheetName, ordRows[0].next, src.color]);

    for (const n of nodesRes.rows) {
      await client.query(
        `INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, image_url, definition_color, needs_review, level, sort_order, collapsed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [idMap.get(n.id), newSheetId, n.parent_id ? idMap.get(n.parent_id) : null, n.name, n.translation, n.definition, newImageUrls.get(n.id) || null, n.definition_color, n.needs_review, n.level, n.sort_order, n.collapsed]
      );
    }
    for (const d of drawingsRes.rows) {
      await client.query('INSERT INTO drawings (id, sheet_id, color, size, points) VALUES ($1,$2,$3,$4,$5)', [id(), newSheetId, d.color, d.size, d.points]);
    }
    for (const t of textsRes.rows) {
      await client.query('INSERT INTO texts (id, sheet_id, x, y, w, h, color, size, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id(), newSheetId, t.x, t.y, t.w, t.h, t.color, t.size, t.content]);
    }
    await client.query('COMMIT');

    const sheet = { id: newSheetId, name: newSheetName, sortOrder: ordRows[0].next, color: src.color };
    ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:created', sheet });
    res.json(sheet);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'duplicate_failed', message: err.message });
  } finally {
    client.release();
  }
});

// Full flat dump of a sheet's contents (used only by client-side undo to
// snapshot a sheet right before deleting it, so it can be fully restored).
// Unlike a single node's delete, deleting a *sheet* doesn't clean up its
// nodes' images from storage, so image URLs are still valid after -- safe
// to carry through to a restore.
router.get('/sheets/:id/full', async (req, res) => {
  const nodesRes = await pool.query(
    'SELECT id, parent_id AS "parentId", name, translation, definition, image_url AS "imageUrl", definition_color AS "definitionColor", needs_review AS "needsReview", level, sort_order AS "sortOrder", collapsed FROM nodes WHERE sheet_id = $1',
    [req.params.id]
  );
  const drawingsRes = await pool.query('SELECT id, color, size, points FROM drawings WHERE sheet_id = $1', [req.params.id]);
  const textsRes = await pool.query('SELECT id, x, y, w, h, color, size, content FROM texts WHERE sheet_id = $1', [req.params.id]);
  res.json({ nodes: nodesRes.rows, drawings: drawingsRes.rows, texts: textsRes.rows });
});

// Recreates a sheet with its *original* id (used only by client-side
// undo/redo): with no nodes/drawings/texts, this just brings back an empty
// sheet that was undone-away; with them, it fully restores a deleted sheet.
// Everything keeps its original id via ON CONFLICT DO NOTHING so redoing a
// later delete of the same sheet can target the same id again.
router.post('/sheets/restore', async (req, res) => {
  const { id: sheetId, name, sortOrder, color, nodes, drawings, texts } = req.body;
  if (!sheetId) return res.status(400).json({ error: 'id_required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let ord = sortOrder;
    if (ord == null) {
      const { rows } = await client.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM sheets');
      ord = rows[0].next;
    }
    await client.query(
      'INSERT INTO sheets (id, name, sort_order, color) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      [sheetId, name || 'ไม่มีชื่อ', ord, color || null]
    );
    for (const n of (nodes || [])) {
      await client.query(
        `INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, image_url, definition_color, needs_review, level, sort_order, collapsed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [n.id, sheetId, n.parentId || null, n.name || '', n.translation || '', n.definition || '', n.imageUrl || null, n.definitionColor || null, !!n.needsReview, n.level || 1, n.sortOrder || 0, !!n.collapsed]
      );
    }
    for (const d of (drawings || [])) {
      await client.query('INSERT INTO drawings (id, sheet_id, color, size, points) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [d.id, sheetId, d.color, d.size, JSON.stringify(d.points)]);
    }
    for (const t of (texts || [])) {
      await client.query('INSERT INTO texts (id, sheet_id, x, y, w, h, color, size, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING', [t.id, sheetId, t.x, t.y, t.w, t.h, t.color, t.size, t.content || '']);
    }
    await client.query('COMMIT');
    const sheet = { id: sheetId, name: name || 'ไม่มีชื่อ', sortOrder: ord, color: color || null };
    ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:created', sheet });
    res.json(sheet);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'restore_failed', message: err.message });
  } finally {
    client.release();
  }
});

router.delete('/sheets/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sheets');
  if (rows[0].n <= 1) return res.status(400).json({ error: 'last_sheet' });
  await pool.query('DELETE FROM sheets WHERE id = $1', [req.params.id]);
  ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:deleted', id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
