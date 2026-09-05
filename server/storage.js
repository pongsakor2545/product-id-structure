const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'product-images';

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function isConfigured() {
  return !!supabase;
}

async function ensureBucket() {
  if (!supabase) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) { console.error('Could not list storage buckets:', error.message); return; }
  if (!buckets.some((b) => b.name === BUCKET)) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (createErr && !/already exists/i.test(createErr.message)) {
      console.error('Could not create storage bucket:', createErr.message);
    }
  }
}

function parseDataUri(dataUri) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function uploadImage(nodeId, dataUri) {
  if (!supabase) throw new Error('Supabase Storage is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
  const parsed = parseDataUri(dataUri);
  if (!parsed) throw new Error('invalid image data');
  const ext = (parsed.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  const path = `${nodeId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, parsed.buffer, { contentType: parsed.mime, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function pathFromUrl(url) {
  const marker = `/object/public/${BUCKET}/`;
  const idx = (url || '').indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length);
}

async function deleteImageByUrl(url) {
  if (!supabase || !url) return;
  const path = pathFromUrl(url);
  if (!path) return;
  await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
}

// Used when duplicating a sheet: each node needs its own independent file so
// deleting one node's image later doesn't remove the other's.
async function copyImage(sourceUrl, newNodeId) {
  if (!supabase || !sourceUrl) return sourceUrl;
  const fromPath = pathFromUrl(sourceUrl);
  if (!fromPath) return sourceUrl;
  const ext = fromPath.includes('.') ? fromPath.slice(fromPath.lastIndexOf('.')) : '';
  const toPath = `${newNodeId}-${Date.now()}${ext}`;
  const { error } = await supabase.storage.from(BUCKET).copy(fromPath, toPath);
  if (error) return sourceUrl;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(toPath);
  return data.publicUrl;
}

module.exports = { isConfigured, ensureBucket, uploadImage, deleteImageByUrl, copyImage };
