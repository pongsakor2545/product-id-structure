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
        `INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, image_url, definition_color, level, sort_order, collapsed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [idMap.get(n.id), newSheetId, n.parent_id ? idMap.get(n.parent_id) : null, n.name, n.translation, n.definition, newImageUrls.get(n.id) || null, n.definition_color, n.level, n.sort_order, n.collapsed]
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

router.delete('/sheets/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sheets');
  if (rows[0].n <= 1) return res.status(400).json({ error: 'last_sheet' });
  await pool.query('DELETE FROM sheets WHERE id = $1', [req.params.id]);
  ws.broadcastAll({ senderClientId: req.get('X-Client-Id') || null, type: 'sheet:deleted', id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
