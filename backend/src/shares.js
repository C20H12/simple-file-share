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

// code -> bytes the share takes in storage (files not yet deleted). Counted
// from the moment a share is created, so space is set aside before its upload
// begins; rebuilt from storage on startup.
const shareBytes = new Map();
const bytesOf = (meta) => meta.files.reduce((sum, f) => sum + (f.downloadedAt ? 0 : f.storedSize), 0);

// Total bytes all shares take, or will once their uploads finish.
export const storedBytes = () => {
  let total = 0;
  for (const bytes of shareBytes.values()) total += bytes;
  return total;
};

// Sets space aside for a new share, if it fits within `limit`. Synchronous, so
// two requests cannot both take the last of the space. Returns false if not.
export function reserveSpace(meta, limit) {
  const bytes = bytesOf(meta);
  if (storedBytes() + bytes > limit) return false;
  shareBytes.set(meta.code, bytes);
  return true;
}

export const releaseSpace = (code) => shareBytes.delete(code);

// code -> Map(fileId -> bytes received), for uploads in flight.
const uploadProgress = new Map();

// code -> number of downloads being streamed. The sweeper leaves these shares
// alone so a download that began before expiry can finish.
const activeDownloads = new Map();

// "code/fileId" for one-time files that someone is downloading right now.
const claimedFiles = new Set();

// Runs tasks for the same share one at a time, so two requests cannot both
// read a record, change it and overwrite each other's update.
const locks = new Map();
function withLock(code, task) {
  const run = (locks.get(code) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {}).finally(() => {
    if (locks.get(code) === tail) locks.delete(code);
  });
  locks.set(code, tail);
  return run;
}

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
    if (!meta) continue;
    expiryIndex.set(meta.code, Date.parse(meta.expiresAt));
    shareBytes.set(meta.code, bytesOf(meta));
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
  shareBytes.set(meta.code, bytesOf(meta));
}

// Returns the share record, or null if it does not exist or has expired.
export async function getShare(code) {
  const expiresAt = expiryIndex.get(code);
  if (expiresAt === undefined || expiresAt <= Date.now()) return null;
  return readMeta(code);
}

export async function deleteShare(code) {
  expiryIndex.delete(code);
  shareBytes.delete(code);
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

// Marks a download as running; call the returned function when it ends.
export function beginDownload(code) {
  activeDownloads.set(code, (activeDownloads.get(code) ?? 0) + 1);
  return () => {
    const left = activeDownloads.get(code) - 1;
    if (left > 0) activeDownloads.set(code, left);
    else activeDownloads.delete(code);
  };
}

// Reserves a one-time file for a single download. Returns false if another
// download of it is already running.
export function claimFile(code, fileId) {
  const key = `${code}/${fileId}`;
  if (claimedFiles.has(key)) return false;
  claimedFiles.add(key);
  return true;
}

export const releaseFile = (code, fileId) => claimedFiles.delete(`${code}/${fileId}`);

// Called once a one-time file has been downloaded in full: deletes the file,
// and the whole share when it was the last one left.
export function burnFile(code, fileId) {
  return withLock(code, async () => {
    const share = await readMeta(code);
    const file = share?.files.find((f) => f.id === fileId);
    if (!file || file.downloadedAt) return;
    file.downloadedAt = new Date().toISOString();
    if (share.files.every((f) => f.downloadedAt)) {
      await deleteShare(code);
      return;
    }
    // Record first, then delete: if the delete fails the file is still never
    // served again, and it is removed with the rest of the share later.
    await saveShare(share);
    await storage.removeObject(bucket, fileKey(code, fileId));
  });
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
      if (expiresAt > now || activeDownloads.has(code)) continue;
      try {
        await deleteShare(code);
      } catch (err) {
        expiryIndex.set(code, expiresAt); // retry on the next pass
        console.error(`failed to delete expired share ${code}:`, err.message);
      }
    }
  };
  return setInterval(sweep, intervalMs).unref();
}
