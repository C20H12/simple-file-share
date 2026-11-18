import { completeShare, createShare, getUploadProgress, uploadFile } from './api.js';
import { CHUNK_SIZE, deriveShareKeys, encryptFile, randomBytes, toBase64 } from './crypto.js';
import { formatSize } from './format.js';

const POLL_MS = 200;

// Most an uploaded share may hold in total (50 MB). The backend enforces the
// same limit (MAX_SHARE_BYTES); keep the two in step. Peer shares have none.
export const MAX_UPLOAD_BYTES = 50 * 1000 ** 2;
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / 1000 ** 2} MB`;

// Shown when the server refuses an upload because its storage is full.
export const STORAGE_FULL_MESSAGE = 'The server is out of storage space right now. Try again later, or use Peer share, which sends files directly without storing them.';

// What to tell the sender when `files` are too large to upload, or null.
export function uploadTooLarge(files) {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= MAX_UPLOAD_BYTES) return null;
  return `These files add up to ${formatSize(total)}. Uploads are limited to ${MAX_UPLOAD_LABEL}; use Peer share to send larger files.`;
}

export const EXPIRY_OPTIONS = ['1 hour', '12 hours', '1 day', '7 days', 'After first download'];
export const DEFAULT_EXPIRY = 'After first download';
const EXPIRY_HOURS = { '1 hour': 1, '12 hours': 12, '1 day': 24, '7 days': 168 };

// Turns the dialog's expiry choice into the API's shape.
function toApiExpiry(expiry) {
  if (expiry === 'After first download') return { type: 'first-download' };
  return { type: 'in', hours: EXPIRY_HOURS[expiry] };
}

// Uploads files as one share and resolves with { code, expiresAt, ... }.
// With a password, each file is encrypted in the browser before it is sent.
// onProgress receives { phase: 'encrypting' | 'uploading', percent } where
// percent is the share of bytes the server has received.
export async function uploadShare({ files, expiry, password, onProgress, signal }) {
  const keys = password ? await deriveShareKeys(password) : null;
  const nonces = files.map(() => (keys ? randomBytes(8) : null));

  const share = await createShare({
    files: files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, ...(keys && { nonce: toBase64(nonces[i]) }) })),
    expiry: toApiExpiry(expiry),
    ...(keys && { encryption: { kdf: keys.kdf, verifier: keys.verifier, chunkSize: CHUNK_SIZE } }),
  }, signal);
  const { code, uploadToken } = share;

  let phase = 'uploading';
  let percent = 0;
  const report = () => onProgress?.({ phase, percent });
  const poll = setInterval(async () => {
    try {
      const { received, total } = await getUploadProgress(code, uploadToken, signal);
      percent = Math.max(percent, total ? Math.floor((received / total) * 100) : 100);
      report();
    } catch { /* a missed poll only delays the bar */ }
  }, POLL_MS);

  try {
    for (const [i, file] of files.entries()) {
      let body = file;
      if (keys) {
        phase = 'encrypting';
        report();
        body = await encryptFile(file, keys.key, nonces[i], { signal });
      }
      phase = 'uploading';
      report();
      await uploadFile(code, share.files[i].id, body, uploadToken, signal);
    }
    const done = await completeShare(code, uploadToken, signal);
    percent = 100;
    report();
    return done;
  } finally {
    clearInterval(poll);
  }
}
