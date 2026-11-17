import { completeShare, createShare, getUploadProgress, uploadFile } from './api.js';
import { CHUNK_SIZE, deriveShareKeys, encryptFile, randomBytes, toBase64 } from './crypto.js';

const POLL_MS = 200;

export const EXPIRY_OPTIONS = ['1 hour', '1 day', '7 days', '30 days', 'After first download', 'Custom date'];
const EXPIRY_HOURS = { '1 hour': 1, '1 day': 24, '7 days': 168, '30 days': 720 };

// Turns the dialog's expiry choice into the API's shape. A custom date runs
// to the end of that day in the sender's time zone.
function toApiExpiry(expiry, customDate) {
  if (expiry === 'After first download') return { type: 'first-download' };
  if (expiry === 'Custom date') return { type: 'date', date: new Date(`${customDate}T23:59:59`).toISOString() };
  return { type: 'in', hours: EXPIRY_HOURS[expiry] };
}

// Uploads files as one share and resolves with { code, expiresAt, ... }.
// With a password, each file is encrypted in the browser before it is sent.
// onProgress receives { phase: 'encrypting' | 'uploading', percent } where
// percent is the share of bytes the server has received.
export async function uploadShare({ files, expiry, customDate, password, onProgress, signal }) {
  const keys = password ? await deriveShareKeys(password) : null;
  const nonces = files.map(() => (keys ? randomBytes(8) : null));

  const share = await createShare({
    files: files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, ...(keys && { nonce: toBase64(nonces[i]) }) })),
    expiry: toApiExpiry(expiry, customDate),
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
