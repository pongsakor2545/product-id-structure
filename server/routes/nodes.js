const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const ws = require('../ws');
const storage = require('../storage');

const patchRouter = require('../wrapAsync');
const router = patchRouter(express.Router());

function id() { return crypto.randomUUID(); }

const LIST_SELECT = `
  SELECT n.id, n.name, n.translation, n.definition, n.level, n.collapsed,
    n.image_url AS "imageUrl",
    COUNT(c.id)::int AS "childCount"
  FROM nodes n
  LEFT JOIN nodes c ON c.parent_id = n.id
`;
const LIST_GROUP_ORDER = 'GROUP BY n.id, n.name, n.translation, n.definition, n.level, n.collapsed, n.image_url, n.sort_order ORDER BY n.sort_order ASC';

router.get('/sheets/:sheetId/nodes', async (req, res) => {
  const isRoot = !req.query.parent || req.query.parent === 'root';
  const params = isRoot ? [req.params.sheetId] : [req.params.sheetId, req.query.parent];
  const where = isRoot ? 'n.parent_id IS NULL' : 'n.parent_id = $2';
  const { rows } = await pool.query(
    `${LIST_SELECT} WHERE n.sheet_id = $1 AND ${where} ${LIST_GROUP_ORDER}`,
    params
  );
  res.json(rows);
});

router.get('/nodes/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.id, n.sheet_id AS "sheetId", n.parent_id AS "parentId", n.name, n.translation, n.definition, n.image_url AS "imageUrl", n.level, n.collapsed,
      COUNT(c.id)::int AS "childCount"
     FROM nodes n
     LEFT JOIN nodes c ON c.parent_id = n.id
     WHERE n.id = $1
     GROUP BY n.id, n.sheet_id, n.parent_id, n.name, n.translation, n.definition, n.image_url, n.level, n.collapsed`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.get('/nodes/:id/ancestors', async (req, res) => {
  const { rows } = await pool.query(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id, name, 0 AS depth FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, n.name, a.depth + 1 FROM nodes AS n JOIN anc AS a ON n.id = a.parent_id
     )
     SELECT id, name FROM anc ORDER BY depth DESC`,
    [req.params.id]
  );
  res.json(rows);
});

router.get('/sheets/:sheetId/search', async (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%';
  if (q === '%%') return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, name, translation, level FROM nodes
     WHERE sheet_id = $1 AND (name ILIKE $2 OR translation ILIKE $2)
     ORDER BY name ASC LIMIT 50`,
    [req.params.sheetId, q]
  );
  for (const r of rows) {
    const anc = await pool.query(
      `WITH RECURSIVE a AS (
         SELECT id, parent_id, name, 0 AS depth FROM nodes WHERE id = $1
         UNION ALL
         SELECT n.id, n.parent_id, n.name, a.depth + 1 FROM nodes AS n JOIN a ON n.id = a.parent_id
       )
       SELECT id, name FROM a WHERE id != $1 ORDER BY depth DESC`,
      [r.id]
    );
    r.path = anc.rows;
  }
  res.json(rows);
});

router.post('/sheets/:sheetId/nodes', async (req, res) => {
  const { parentId, name } = req.body;
  let level = 1;
  if (parentId) {
    const p = await pool.query('SELECT level FROM nodes WHERE id = $1', [parentId]);
    if (!p.rows[0]) return res.status(404).json({ error: 'parent_not_found' });
    level = p.rows[0].level + 1;
  }
  const ord = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM nodes WHERE sheet_id = $1 AND (parent_id = $2 OR (parent_id IS NULL AND $2 IS NULL))',
    [req.params.sheetId, parentId || null]
  );
  const node = {
    id: id(), sheetId: req.params.sheetId, parentId: parentId || null,
    name: (name || 'New Category').trim(), translation: '', definition: '', level,
    collapsed: false, sortOrder: ord.rows[0].next, imageUrl: null, childCount: 0
  };
  await pool.query(
    `INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, level, sort_order)
     VALUES ($1,$2,$3,$4,'','',$5,$6)`,
    [node.id, node.sheetId, node.parentId, node.name, node.level, node.sortOrder]
  );
  ws.broadcast(req.params.sheetId, { senderClientId: req.get('X-Client-Id') || null, type: 'node:created', parentId: node.parentId, node });
  res.json(node);
});

router.patch('/nodes/:id', async (req, res) => {
  const found = await pool.query('SELECT sheet_id, image_url FROM nodes WHERE id = $1', [req.params.id]);
  if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });

  const allowed = ['name', 'translation', 'definition', 'image', 'collapsed'];
  const sets = [];
  const params = [];
  let n = 1;
  const broadcastPatch = {};
  for (const key of allowed) {
    if (!(key in req.body)) continue;
    if (key === 'image') {
      let url = req.body.image;
      if (typeof url === 'string' && url.startsWith('data:')) {
        if (!storage.isConfigured()) {
          return res.status(400).json({ error: 'not_configured', message: 'Image storage is not configured (missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)' });
        }
        url = await storage.uploadImage(req.params.id, url);
      }
      if (found.rows[0].image_url && found.rows[0].image_url !== url) {
        storage.deleteImageByUrl(found.rows[0].image_url).catch(() => {});
      }
      sets.push(`image_url = $${n++}`);
      params.push(url || null);
      broadcastPatch.imageUrl = url || null;
      continue;
    }
    sets.push(`${key} = $${n++}`);
    params.push(req.body[key]);
    broadcastPatch[key] = req.body[key];
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push('updated_at = now()');
  params.push(req.params.id);

  await pool.query(`UPDATE nodes SET ${sets.join(', ')} WHERE id = $${n}`, params);
  ws.broadcast(found.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'node:updated', id: req.params.id, patch: broadcastPatch });
  res.json({ ok: true, imageUrl: 'imageUrl' in broadcastPatch ? broadcastPatch.imageUrl : undefined });
});

router.delete('/nodes/:id', async (req, res) => {
  const found = await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, image_url FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.image_url FROM nodes AS n JOIN subtree AS s ON n.parent_id = s.id
     )
     SELECT image_url FROM subtree WHERE image_url IS NOT NULL`,
    [req.params.id]
  );
  const meta = await pool.query('SELECT sheet_id, parent_id FROM nodes WHERE id = $1', [req.params.id]);
  if (!meta.rows[0]) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM nodes WHERE id = $1', [req.params.id]);
  for (const row of found.rows) {
    storage.deleteImageByUrl(row.image_url).catch(() => {});
  }
  ws.broadcast(meta.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'node:deleted', id: req.params.id, parentId: meta.rows[0].parent_id });
  res.json({ ok: true });
});

router.post('/nodes/:id/move', async (req, res) => {
  const { targetParentId } = req.body;
  const nodeId = req.params.id;
  if (nodeId === targetParentId) return res.status(400).json({ error: 'invalid_target' });

  const nodeRes = await pool.query('SELECT sheet_id, parent_id, level FROM nodes WHERE id = $1', [nodeId]);
  if (!nodeRes.rows[0]) return res.status(404).json({ error: 'not_found' });
  const targetRes = await pool.query('SELECT sheet_id, level FROM nodes WHERE id = $1', [targetParentId]);
  if (!targetRes.rows[0]) return res.status(404).json({ error: 'target_not_found' });
  if (targetRes.rows[0].sheet_id !== nodeRes.rows[0].sheet_id) return res.status(400).json({ error: 'cross_sheet' });

  const cycle = await pool.query(
    `WITH RECURSIVE anc AS (
       SELECT id, parent_id FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id FROM nodes AS n JOIN anc AS a ON n.id = a.parent_id
     )
     SELECT 1 FROM anc WHERE id = $2 LIMIT 1`,
    [targetParentId, nodeId]
  );
  if (cycle.rows[0]) return res.status(400).json({ error: 'would_cycle' });

  const oldParentId = nodeRes.rows[0].parent_id;
  const newLevel = targetRes.rows[0].level + 1;
  const ord = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM nodes WHERE parent_id = $1', [targetParentId]);

  await pool.query('UPDATE nodes SET parent_id = $1, sort_order = $2, collapsed = FALSE WHERE id = $3', [targetParentId, ord.rows[0].next, nodeId]);
  await pool.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, $2::int AS new_level FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, s.new_level + 1 FROM nodes AS n JOIN subtree AS s ON n.parent_id = s.id
     )
     UPDATE nodes SET level = subtree.new_level FROM subtree WHERE nodes.id = subtree.id`,
    [nodeId, newLevel]
  );

  ws.broadcast(nodeRes.rows[0].sheet_id, { senderClientId: req.get('X-Client-Id') || null, type: 'node:moved', id: nodeId, oldParentId, newParentId: targetParentId, newLevel });
  res.json({ ok: true, newLevel });
});

module.exports = router;
