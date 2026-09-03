// Generates a large synthetic taxonomy to verify lazy-loading and search stay
// fast at the scale the user described (tens of thousands to hundreds of
// thousands of nodes). Usage: node scripts/seedBulk.js [totalNodes]
require('dotenv').config();
const crypto = require('crypto');
const { pool, migrate } = require('../server/db');

function id() { return crypto.randomUUID(); }

async function main() {
  const total = parseInt(process.argv[2] || '50000', 10);
  await migrate();

  const sheetId = id();
  await pool.query('INSERT INTO sheets (id, name, sort_order) VALUES ($1, $2, 0)', [sheetId, 'Bulk Test (' + total + ' nodes)']);

  const ROOT_COUNT = 40;
  const MID_PER_ROOT = 40;
  let created = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let r = 0; r < ROOT_COUNT && created < total; r++) {
      const rootId = id();
      await client.query(
        'INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, level, sort_order) VALUES ($1,$2,NULL,$3,$4,$5,1,$6)',
        [rootId, sheetId, 'Category ' + r, 'หมวด ' + r, '', r]
      );
      created++;
      for (let m = 0; m < MID_PER_ROOT && created < total; m++) {
        const midId = id();
        await client.query(
          'INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, level, sort_order) VALUES ($1,$2,$3,$4,$5,$6,2,$7)',
          [midId, sheetId, rootId, 'Category ' + r + '.' + m, 'หมวดย่อย ' + r + '.' + m, '', m]
        );
        created++;
        let leafIndex = 0;
        while (created < total && leafIndex < 100) {
          const leafId = id();
          await client.query(
            'INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, level, sort_order) VALUES ($1,$2,$3,$4,$5,$6,3,$7)',
            [leafId, sheetId, midId, 'Item ' + r + '.' + m + '.' + leafIndex, 'สินค้า ' + r + '.' + m + '.' + leafIndex, '', leafIndex]
          );
          created++;
          leafIndex++;
          if (created % 2000 === 0) console.log(created + ' / ' + total);
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('Seeded', created, 'nodes into sheet', sheetId);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
