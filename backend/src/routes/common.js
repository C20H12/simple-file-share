import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { lookupMisses } from '../limits.js';
import { getShare } from '../shares.js';

// Loads the share named in the URL, or throws 404. With `ready`, shares still
// being uploaded count as missing. Misses are rate-limited per client address.
export async function loadShare(req, { ready = false } = {}) {
  const wait = lookupMisses.retryAfter(req.ip, config.limits.lookupMisses);
  if (wait) throw new HttpError(429, 'too many attempts, try again later', { retryAfter: wait });

  const { code } = req.params;
  const share = /^\d{6}$/.test(code) ? await getShare(code) : null;
  if (!share || (ready && share.status !== 'ready')) {
    lookupMisses.record(req.ip);
    throw new HttpError(404, 'share not found');
  }
  return share;
}

export const bearerToken = (req) => /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? null;

export const isBase64Bytes = (value, bytes) =>
  typeof value === 'string' && Buffer.from(value, 'base64').length === bytes;
