import { randomInt } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { storage, bucket } from './storage.js';

// Share metadata lives next to the files in MinIO, so there is no database:
//   meta/{code}.json          the share record
//   files/{code}/{fileId}     file contents (ciphertext if password-protected)
const metaKey = (code) => `meta/${code}.json`;
export const fileKey = (code, fileId) => `files/${code}/${fileId}`;

// code -> expiry time (ms). Lets the sweeper and code allocation avoid
// reading every record; rebuilt from storage on startup.
const expiryIndex = new Map();

// code -> Map(fileId -> bytes received), for uploads in flight.
const uploadProgress = new Map();

async function list(prefix) {
  const keys = [];
  for await (const obj of storage.listObjectsV2(bucket, prefix, true)) keys.push(obj.name);
  return keys;
}

async function readMeta(code) {
  try {
    return JSON.parse(await text(await storage.getObject(bucket, metaKey(code))));
  } catch (err) {
    if (err.code === 'NoSuchKey') return null;
    throw err;
  }
}

export async function loadIndex() {
  for (const key of await list('meta/')) {
    const meta = await readMeta(key.slice('meta/'.length, -'.json'.length));
    if (meta) expiryIndex.set(meta.code, Date.parse(meta.expiresAt));
  }
  return expiryIndex.size;
}

export function allocateCode() {
  for (;;) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!expiryIndex.has(code)) return code;
  }
}

export async function saveShare(meta) {
  await storage.putObject(bucket, metaKey(meta.code), Buffer.from(JSON.stringify(meta)), undefined, {
    'Content-Type': 'application/json',
  });
  expiryIndex.set(meta.code, Date.parse(meta.expiresAt));
}

// Returns the share record, or null if it does not exist or has expired.
export async function getShare(code) {
  const expiresAt = expiryIndex.get(code);
  if (expiresAt === undefined || expiresAt <= Date.now()) return null;
  return readMeta(code);
}

export async function deleteShare(code) {
  expiryIndex.delete(code);
  uploadProgress.delete(code);
  const keys = await list(`files/${code}/`);
  if (keys.length) await storage.removeObjects(bucket, keys);
  await storage.removeObject(bucket, metaKey(code));
}

export async function storedSize(code, fileId) {
  try {
    return (await storage.statObject(bucket, fileKey(code, fileId))).size;
  } catch (err) {
    if (err.code === 'NotFound') return null;
    throw err;
  }
}

export function setReceived(code, fileId, bytes) {
  if (!uploadProgress.has(code)) uploadProgress.set(code, new Map());
  uploadProgress.get(code).set(fileId, bytes);
}

export const getReceived = (code, fileId) => uploadProgress.get(code)?.get(fileId) ?? 0;
export const clearProgress = (code) => uploadProgress.delete(code);

// Deletes expired shares, including uploads that were never completed.
export function startSweeper(intervalMs) {
  const sweep = async () => {
    const now = Date.now();
    for (const [code, expiresAt] of expiryIndex) {
      if (expiresAt > now) continue;
      try {
        await deleteShare(code);
        console.log(`share ${code} expired, deleted`);
      } catch (err) {
        expiryIndex.set(code, expiresAt); // retry on the next pass
        console.error(`failed to delete expired share ${code}:`, err.message);
      }
    }
  };
  return setInterval(sweep, intervalMs).unref();
}
