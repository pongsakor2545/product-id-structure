require('dotenv').config();
const crypto = require('crypto');
const { pool, migrate } = require('../server/db');

function id() { return crypto.randomUUID(); }

async function insertNode(sheetId, parentId, level, sortOrder, name, translation, definition) {
  const nodeId = id();
  await pool.query(
    'INSERT INTO nodes (id, sheet_id, parent_id, name, translation, definition, level, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [nodeId, sheetId, parentId, name, translation, definition, level, sortOrder]
  );
  return nodeId;
}

async function main() {
  await migrate();
  const sheetId = id();
  await pool.query('INSERT INTO sheets (id, name, sort_order) VALUES ($1, $2, 0)', [sheetId, 'ชุดที่ 1']);

  const electronics = await insertNode(sheetId, null, 1, 0, 'Electronics', 'อิเล็กทรอนิกส์', 'สินค้าประเภทอุปกรณ์อิเล็กทรอนิกส์และดิจิทัลทุกชนิด');
  const mobilePhones = await insertNode(sheetId, electronics, 2, 0, 'Mobile Phones', 'โทรศัพท์มือถือ', 'อุปกรณ์สื่อสารพกพาทุกประเภท');
  await insertNode(sheetId, mobilePhones, 3, 0, 'Smartphones', 'สมาร์ทโฟน', 'โทรศัพท์มือถือระบบสัมผัสที่รองรับแอปพลิเคชัน');
  await insertNode(sheetId, mobilePhones, 3, 1, 'Feature Phones', 'ฟีเจอร์โฟน', '');
  const laptops = await insertNode(sheetId, electronics, 2, 1, 'Laptops', 'คอมพิวเตอร์โน้ตบุ๊ก', '');
  await insertNode(sheetId, laptops, 3, 0, 'Ultrabooks', 'อัลตราบุ๊ก', '');
  await insertNode(sheetId, laptops, 3, 1, 'Gaming Laptops', 'เกมมิ่งโน้ตบุ๊ก', '');
  await insertNode(sheetId, electronics, 2, 2, 'Accessories', 'อุปกรณ์เสริม', '');

  const fashion = await insertNode(sheetId, null, 1, 1, 'Fashion & Apparel', 'แฟชั่นและเครื่องแต่งกาย', '');
  await insertNode(sheetId, fashion, 2, 0, "Men's Clothing", 'เสื้อผ้าผู้ชาย', '');
  const womens = await insertNode(sheetId, fashion, 2, 1, "Women's Clothing", 'เสื้อผ้าผู้หญิง', '');
  await insertNode(sheetId, womens, 3, 0, 'Dresses', 'เดรส', '');
  await insertNode(sheetId, womens, 3, 1, 'Tops', 'เสื้อ', '');

  const home = await insertNode(sheetId, null, 1, 2, 'Home & Living', 'บ้านและของใช้ในบ้าน', '');
  await insertNode(sheetId, home, 2, 0, 'Furniture', 'เฟอร์นิเจอร์', '');
  await insertNode(sheetId, home, 2, 1, 'Kitchenware', 'เครื่องครัว', '');

  console.log('Seeded demo sheet', sheetId);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
