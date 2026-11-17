import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { Router } from 'express';
import { config } from '../config.js';
import { storage, bucket } from '../storage.js';
import { hashSecret } from '../password.js';
import {
  allocateCode, clearProgress, fileKey, getReceived, getShare, saveShare, setReceived, storedSize,
} from '../shares.js';

const HOUR = 3600_000;
const DURATION_HOURS = new Set([1, 24, 7 * 24, 30 * 24]);
const PENDING_TTL = HOUR; // time allowed to finish uploading
const FIRST_DOWNLOAD_TTL = 30 * 24 * HOUR; // cap for shares nobody downloads
const MAX_CUSTOM_EXPIRY = 365 * 24 * HOUR;
const GCM_TAG_BYTES = 16;
const CHUNK_SIZE_RANGE = [64 * 1024, 16 * 1024 * 1024];

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (message) => new HttpError(400, message);

const sha256 = (value) => createHash('sha256').update(value).digest();
const isBase64Bytes = (value, bytes) =>
  typeof value === 'string' && Buffer.from(value, 'base64').length === bytes;

// Password-protected files are encrypted in the browser in fixed-size chunks,
// each carrying its own AES-GCM tag, so the stored size is larger than the file.
const encryptedSize = (size, chunkSize) =>
  size + GCM_TAG_BYTES * Math.max(1, Math.ceil(size / chunkSize));

function parseExpiry(expiry) {
  if (expiry?.type === 'in' && DURATION_HOURS.has(expiry.hours)) return { type: 'in', hours: expiry.hours };
  if (expiry?.type === 'first-download') return { type: 'first-download' };
  if (expiry?.type === 'date') {
    const at = Date.parse(expiry.date);
    if (Number.isNaN(at)) throw bad('expiry.date is not a valid date');
    if (at <= Date.now()) throw bad('expiry.date must be in the future');
    if (at > Date.now() + MAX_CUSTOM_EXPIRY) throw bad('expiry.date is more than a year away');
    return { type: 'date', date: new Date(at).toISOString() };
  }
  throw bad('expiry must be { type: "in", hours: 1|24|168|720 }, { type: "date", date } or { type: "first-download" }');
}

// The browser derives two values from the password: an encryption key, which
// never leaves it, and a verifier, which is all the server sees and is stored
// only as a hash. `kdf` is kept so receivers can repeat the derivation.
function parseEncryption(encryption) {
  if (encryption == null) return null;
  const { kdf, verifier, chunkSize } = encryption;
  if (kdf?.name !== 'PBKDF2' || kdf.hash !== 'SHA-512') throw bad('encryption.kdf must be PBKDF2 with SHA-512');
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 100_000 || kdf.iterations > 5_000_000) throw bad('encryption.kdf.iterations is out of range');
  if (!isBase64Bytes(kdf.salt, 16)) throw bad('encryption.kdf.salt must be 16 bytes, base64');
  if (!isBase64Bytes(verifier, 32)) throw bad('encryption.verifier must be 32 bytes, base64');
  if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_SIZE_RANGE[0] || chunkSize > CHUNK_SIZE_RANGE[1]) throw bad('encryption.chunkSize is out of range');
  return {
    alg: 'AES-256-GCM',
    chunkSize,
    kdf: { name: 'PBKDF2', hash: 'SHA-512', iterations: kdf.iterations, salt: kdf.salt },
    verifier,
  };
}

function parseFiles(files, encryption) {
  const { maxFiles, maxBytes } = config.shares;
  if (!Array.isArray(files) || files.length === 0) throw bad('files must be a non-empty array');
  if (files.length > maxFiles) throw bad(`a share can hold at most ${maxFiles} files`);
  const parsed = files.map((file, i) => {
    const { name, size, type, nonce } = file ?? {};
    if (typeof name !== 'string' || !name.length || name.length > 255) throw bad(`files[${i}].name must be 1-255 characters`);
    if (!Number.isSafeInteger(size) || size < 0) throw bad(`files[${i}].size must be a non-negative integer`);
    if (encryption && !isBase64Bytes(nonce, 8)) throw bad(`files[${i}].nonce must be 8 bytes, base64`);
    return {
      id: randomUUID(),
      name,
      size,
      type: typeof type === 'string' && type.length <= 255 ? type : '',
      storedSize: encryption ? encryptedSize(size, encryption.chunkSize) : size,
      ...(encryption && { nonce }),
    };
  });
  const total = parsed.reduce((sum, f) => sum + f.storedSize, 0);
  if (total > maxBytes) throw new HttpError(413, `a share can hold at most ${maxBytes} bytes`);
  return parsed;
}

// Loads the share named in the URL and checks the caller's upload token.
async function requireUploader(req, _res, next) {
  const { code } = req.params;
  const share = /^\d{6}$/.test(code) ? await getShare(code) : null;
  if (!share) throw new HttpError(404, 'share not found');
  const token = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
  if (!token || !timingSafeEqual(sha256(token), Buffer.from(share.uploadTokenHash, 'base64'))) {
    throw new HttpError(401, 'invalid upload token');
  }
  req.share = share;
  next();
}

function progressOf(share) {
  const done = share.status === 'ready';
  const files = share.files.map((f) => ({
    id: f.id,
    size: f.storedSize,
    received: done ? f.storedSize : Math.min(getReceived(share.code, f.id), f.storedSize),
  }));
  return {
    status: share.status,
    received: files.reduce((sum, f) => sum + f.received, 0),
    total: files.reduce((sum, f) => sum + f.size, 0),
    files,
  };
}

export const sharesRouter = Router();

// Create a share: declare the files, expiry and (optionally) password
// protection. Returns the 6-digit code and a token for the upload calls.
sharesRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  const expiry = parseExpiry(body.expiry);
  const encryption = parseEncryption(body.encryption);
  const files = parseFiles(body.files, encryption);
  const uploadToken = randomBytes(32).toString('base64url');
  const now = Date.now();

  let password = null;
  if (encryption) {
    const { verifier, ...params } = encryption;
    password = { ...params, verifierHash: await hashSecret(Buffer.from(verifier, 'base64')) };
  }

  const share = {
    code: allocateCode(),
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_TTL).toISOString(),
    expiry,
    burnAfterDownload: expiry.type === 'first-download',
    uploadTokenHash: sha256(uploadToken).toString('base64'),
    password,
    files,
  };
  await saveShare(share);

  res.status(201).json({
    code: share.code,
    uploadToken,
    uploadBy: share.expiresAt,
    files: files.map(({ id, name, size, storedSize }) => ({ id, name, size, storedSize })),
  });
});

// Upload one file as the raw request body, streamed straight into storage.
sharesRouter.put('/:code/files/:fileId', requireUploader, async (req, res) => {
  const { share } = req;
  const file = share.files.find((f) => f.id === req.params.fileId);
  if (!file) throw new HttpError(404, 'file not found in this share');
  if (share.status !== 'pending') throw new HttpError(409, 'share is already complete');
  if (req.get('content-length') === undefined) throw new HttpError(411, 'Content-Length is required');
  if (Number(req.get('content-length')) !== file.storedSize) {
    throw bad(`expected ${file.storedSize} bytes for this file`);
  }

  let received = 0;
  setReceived(share.code, file.id, 0);
  const counter = new Transform({
    transform(chunk, _enc, done) {
      received += chunk.length;
      setReceived(share.code, file.id, received);
      done(null, chunk);
    },
  });
  // pipeline() tears the counter down if the client disconnects, which in
  // turn fails the storage write instead of leaving it waiting.
  pipeline(req, counter, () => {});

  try {
    await storage.putObject(bucket, fileKey(share.code, file.id), counter, file.storedSize, {
      'Content-Type': 'application/octet-stream',
    });
  } catch (err) {
    setReceived(share.code, file.id, 0);
    if (req.destroyed && !req.complete) return; // client went away; nothing to answer
    throw err;
  }
  res.status(204).end();
});

// Bytes the server has received so far, per file and in total.
sharesRouter.get('/:code/progress', requireUploader, (req, res) => {
  res.set('Cache-Control', 'no-store').json(progressOf(req.share));
});

// Finish the share once every file is stored. The expiry clock starts here.
sharesRouter.post('/:code/complete', requireUploader, async (req, res) => {
  const { share } = req;
  if (share.status === 'pending') {
    const sizes = await Promise.all(share.files.map((f) => storedSize(share.code, f.id)));
    const missing = share.files.filter((f, i) => sizes[i] !== f.storedSize).map((f) => f.id);
    if (missing.length) throw new HttpError(409, 'some files have not finished uploading', { missing });

    const now = Date.now();
    const { expiry } = share;
    const expiresAt = expiry.type === 'date' ? Date.parse(expiry.date)
      : now + (expiry.type === 'in' ? expiry.hours * HOUR : FIRST_DOWNLOAD_TTL);
    share.status = 'ready';
    share.completedAt = new Date(now).toISOString();
    share.expiresAt = new Date(expiresAt).toISOString();
    await saveShare(share);
    clearProgress(share.code);
  }
  res.json({
    code: share.code,
    expiresAt: share.expiresAt,
    burnAfterDownload: share.burnAfterDownload,
    passwordProtected: !!share.password,
  });
});
