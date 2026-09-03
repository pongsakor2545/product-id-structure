const express = require('express');
const { google } = require('googleapis');
const { pool } = require('../db');

const patchRouter = require('../wrapAsync');
const router = patchRouter(express.Router());

function buildTree(flatNodes) {
  const byId = new Map();
  flatNodes.forEach((n) => byId.set(n.id, Object.assign({}, n, { children: [] })));
  const roots = [];
  flatNodes.forEach((n) => {
    const node = byId.get(n.id);
    if (n.parent_id && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(node);
    else roots.push(node);
  });
  byId.forEach((n) => n.children.sort((a, b) => a.sort_order - b.sort_order));
  roots.sort((a, b) => a.sort_order - b.sort_order);
  return roots;
}

function buildHierarchyExport(tree) {
  let maxDepth = 0;
  function collectLeaves(nodes, ancestors) {
    let out = [];
    nodes.forEach((n) => {
      const path = ancestors.concat([n]);
      if (n.level > maxDepth) maxDepth = n.level;
      if (n.children && n.children.length) out = out.concat(collectLeaves(n.children, path));
      else out.push(path);
    });
    return out;
  }
  const leafPaths = collectLeaves(tree, []);
  if (!maxDepth) maxDepth = 1;

  const header = [];
  for (let lvl = 1; lvl <= maxDepth; lvl++) { header.push('Taxonomy Level ' + lvl); header.push('คำนิยาม'); }

  const rawRows = leafPaths.map((path) => {
    const row = [];
    for (let l = 0; l < maxDepth; l++) row.push(path[l] || null);
    return row;
  });

  const merges = [];
  for (let l = 0; l < maxDepth; l++) {
    let i = 0;
    while (i < rawRows.length) {
      const node = rawRows[i][l];
      if (!node) { i++; continue; }
      let j = i;
      while (j + 1 < rawRows.length && rawRows[j + 1][l] && rawRows[j + 1][l].id === node.id) j++;
      if (j > i) merges.push({ level: l, rowStart: i, rowEnd: j });
      i = j + 1;
    }
  }

  const dataRows = rawRows.map((row, ri) => {
    const out = [];
    row.forEach((node, lvl) => {
      if (!node) { out.push(''); out.push(''); return; }
      const continued = merges.some((m) => m.level === lvl && ri > m.rowStart && ri <= m.rowEnd);
      if (continued) { out.push(''); out.push(''); }
      else { out.push(node.name); out.push(node.definition || ''); }
    });
    return out;
  });

  return { header, rows: dataRows, merges, maxDepth };
}

function getAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

router.post('/sheets/:id/export-to-google', async (req, res) => {
  const auth = getAuth();
  if (!auth) return res.status(400).json({ error: 'not_configured', message: 'GOOGLE_SERVICE_ACCOUNT_JSON is not set on the server.' });
  const { spreadsheetId, gid } = req.body;
  if (!spreadsheetId) return res.status(400).json({ error: 'missing_spreadsheet_id' });
  const sheetGid = Number.isInteger(gid) ? gid : 0;

  const { rows: flat } = await pool.query(
    'SELECT id, parent_id, name, definition, level, sort_order FROM nodes WHERE sheet_id = $1',
    [req.params.id]
  );
  const tree = buildTree(flat);
  const h = buildHierarchyExport(tree);
  const values = [h.header].concat(h.rows);

  try {
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'A1:ZZ100000' });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'A1',
      valueInputOption: 'RAW',
      requestBody: { values }
    });

    const requests = [
      { unmergeCells: { range: { sheetId: sheetGid, startRowIndex: 0, endRowIndex: 200000, startColumnIndex: 0, endColumnIndex: 60 } } }
    ];
    h.merges.forEach((m) => {
      const startRow = m.rowStart + 1, endRow = m.rowEnd + 2;
      requests.push({ mergeCells: { range: { sheetId: sheetGid, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: m.level * 2, endColumnIndex: m.level * 2 + 1 }, mergeType: 'MERGE_ALL' } });
      requests.push({ mergeCells: { range: { sheetId: sheetGid, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: m.level * 2 + 1, endColumnIndex: m.level * 2 + 2 }, mergeType: 'MERGE_ALL' } });
    });
    if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

    res.json({ ok: true, rows: values.length, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` });
  } catch (err) {
    res.status(500).json({ error: 'export_failed', message: err.message });
  }
});

module.exports = router;
