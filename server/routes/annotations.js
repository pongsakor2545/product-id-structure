const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const ws = require('../ws');

const patchRouter = require('../wrapAsync');
const router = patchRouter(express.Router());

function id() { return crypto.randomUUID(); }

router.get('/sheets/:sheetId/drawings', async (req, res) => {
  const { rows } = await pool.query('SELECT id, color, size, points FROM drawings WHERE sheet_id = $1', [req.params.sheetId]);
  res.json(rows);
});
router.get('/sheets/:sheetId/texts', async (req, res) => {
  const { rows } = await pool.query('SELECT id, x, y, w, h, color, size, content FROM texts WHERE sheet_id = $1', [req.params.sheetId]);
  res.json(rows);
});

router.post('/sheets/:sheetId/drawings', async (req, res) => {
  const { color, size, points } = req.body;
  const drawing = { id: id(), color, size, points };
  await pool.query('INSERT INTO drawings (id, sheet_id, color, size, points) VALUES ($1,$2,$3,$4,$5)', [drawing.id, req.params.sheetId, color, size, JSON.stringify(points)]);
  ws.broadcast(req.params.sheetId, { senderClientId: req.get('X-Client-Id') || null, type: 'drawing:created', drawing });
  res.json(drawing);
});
router.patch('/drawings/:id', async (req, res) => {
  const found = await pool.query('SELECT sheet_id FROM drawings WHERE id = $1', [req.params.id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });
  await pool.query('UPDATE drawings SET points = $1 WHERE id = $2', [JSON.stringify(req.body.points), req.params.id]);
  ws.broadcast(found.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'drawing:updated', id: req.params.id, points: req.body.points });
  res.json({ ok: true });
});
router.delete('/drawings/:id', async (req, res) => {
  const found = await pool.query('SELECT sheet_id FROM drawings WHERE id = $1', [req.params.id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM drawings WHERE id = $1', [req.params.id]);
  ws.broadcast(found.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'drawing:deleted', id: req.params.id });
  res.json({ ok: true });
});

router.post('/sheets/:sheetId/texts', async (req, res) => {
  const { x, y, w, h, color, size, content } = req.body;
  const text = { id: id(), x, y, w, h, color, size, content: content || '' };
  await pool.query('INSERT INTO texts (id, sheet_id, x, y, w, h, color, size, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [text.id, req.params.sheetId, x, y, w, h, color, size, text.content]);
  ws.broadcast(req.params.sheetId, { senderClientId: req.get('X-Client-Id') || null, type: 'text:created', text });
  res.json(text);
});
router.patch('/texts/:id', async (req, res) => {
  const allowed = ['x', 'y', 'w', 'h', 'color', 'content'];
  const sets = [];
  const params = [];
  let n = 1;
  const patch = {};
  for (const key of allowed) {
    if (!(key in req.body)) continue;
    sets.push(`${key} = $${n++}`);
    params.push(req.body[key]);
    patch[key] = req.body[key];
  }
  const found = await pool.query('SELECT sheet_id FROM texts WHERE id = $1', [req.params.id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (sets.length) {
    params.push(req.params.id);
    await pool.query(`UPDATE texts SET ${sets.join(', ')} WHERE id = $${n}`, params);
    ws.broadcast(found.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'text:updated', id: req.params.id, patch });
  }
  res.json({ ok: true });
});
router.delete('/texts/:id', async (req, res) => {
  const found = await pool.query('SELECT sheet_id FROM texts WHERE id = $1', [req.params.id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM texts WHERE id = $1', [req.params.id]);
  ws.broadcast(found.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'text:deleted', id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
