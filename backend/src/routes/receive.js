import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { config } from '../config.js';
import { checkAccessToken, issueAccessToken } from '../access.js';
import { HttpError, badRequest as bad } from '../errors.js';
import { unlockFailures } from '../limits.js';
import { verifySecret } from '../password.js';
import { storage, bucket } from '../storage.js';
import { beginDownload, burnFile, claimFile, fileKey, getShare, releaseFile } from '../shares.js';
import { bearerToken, isBase64Bytes, loadShare } from './common.js';

const hasAccess = (req, share) => !share.password || checkAccessToken(share, bearerToken(req));

// The files a receiver can still download. `nonce` is present on encrypted
// files and is needed to decrypt them.
const publicFiles = (share) => share.files
  .filter((f) => !f.downloadedAt)
  .map(({ id, name, size, type, storedSize, nonce }) => ({ id, name, size, type, storedSize, ...(nonce && { nonce }) }));

export const receiveRouter = Router();

// Look up a share by its code. For a password-protected share this returns
// what the browser needs to derive the key, and withholds the file list until
// the request carries an access token from /unlock.
receiveRouter.get('/:code', async (req, res) => {
  const share = await loadShare(req, { ready: true });
  const { password } = share;
  res.set('Cache-Control', 'no-store').json({
    code: share.code,
    expiresAt: share.expiresAt,
    burnAfterDownload: share.burnAfterDownload,
    passwordProtected: !!password,
    encryption: password ? { alg: password.alg, chunkSize: password.chunkSize, kdf: password.kdf } : null,
    files: hasAccess(req, share) ? publicFiles(share) : null,
  });
});

// Exchange the password verifier for an access token and the file list.
receiveRouter.post('/:code/unlock', async (req, res) => {
  const share = await loadShare(req, { ready: true });
  if (!share.password) throw bad('this share is not password-protected');

  const wait = unlockFailures.retryAfter(share.code, config.limits.unlockFailures);
  if (wait) throw new HttpError(429, 'too many wrong passwords, try again later', { retryAfter: wait });

  const verifier = req.body?.verifier;
  if (!isBase64Bytes(verifier, 32)) throw bad('verifier must be 32 bytes, base64');
  if (!(await verifySecret(Buffer.from(verifier, 'base64'), share.password.verifierHash))) {
    unlockFailures.record(share.code);
    throw new HttpError(401, 'wrong password');
  }

  res.set('Cache-Control', 'no-store').json({ ...issueAccessToken(share), files: publicFiles(share) });
});

// Download one file. The body is the stored bytes: the file itself, or its
// ciphertext for a password-protected share (the browser decrypts it).
//
// It is always sent as an opaque attachment, never with the uploader's
// content type, so an uploaded HTML or SVG file cannot run as a page on this
// origin.
receiveRouter.get('/:code/files/:fileId', async (req, res) => {
  let share = await loadShare(req, { ready: true });
  if (!hasAccess(req, share)) throw new HttpError(401, 'password required');
  const { code } = share;
  const { fileId } = req.params;

  // A share that expires after its first download hands each file out once.
  const oneTime = share.burnAfterDownload;
  if (oneTime && !claimFile(code, fileId)) throw new HttpError(409, 'this file is being downloaded');
  // If the share expires mid-download, the sweeper may cut this off (see shares.js).
  const endDownload = beginDownload(code, () => res.destroy());

  try {
    // With the claim held, read the record again: an earlier download of this
    // file may have finished between the first read and the claim.
    if (oneTime) share = await getShare(code);
    const file = share?.files.find((f) => f.id === fileId);
    if (!file) throw new HttpError(404, 'file not found in this share');
    if (file.downloadedAt) throw new HttpError(410, 'this file has already been downloaded');

    const object = await storage.getObject(bucket, fileKey(code, fileId));
    res.attachment(share.password ? `${file.name}.enc` : file.name);
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.storedSize),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });

    try {
      await pipeline(object, res);
    } catch {
      res.destroy(); // client went away or storage failed mid-file; the file stays available
      return;
    }
    if (oneTime) {
      await burnFile(code, fileId).catch((err) => console.error(`failed to delete downloaded file ${code}/${fileId}:`, err.message));
    }
  } finally {
    endDownload();
    if (oneTime) releaseFile(code, fileId);
  }
});
