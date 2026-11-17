import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Access tokens prove a receiver has entered a share's password. They are
// signed rather than stored, with a key made at startup, so a server restart
// simply asks receivers for the password again.
const signingKey = randomBytes(32);
const TTL_MS = 3600_000;

// The share's creation time is part of what is signed, so a token stops
// working if the share is deleted and its code is later given to another.
const sign = (share, expiresAt) =>
  createHmac('sha256', signingKey).update(`${share.code}.${share.createdAt}.${expiresAt}`).digest();

export function issueAccessToken(share) {
  const expiresAt = Math.min(Date.now() + TTL_MS, Date.parse(share.expiresAt));
  return {
    accessToken: `${expiresAt}.${sign(share, expiresAt).toString('base64url')}`,
    accessExpiresAt: new Date(expiresAt).toISOString(),
  };
}

export function checkAccessToken(share, token) {
  const [expiresAt, signature, ...rest] = String(token ?? '').split('.');
  if (rest.length || !/^\d+$/.test(expiresAt) || Number(expiresAt) <= Date.now()) return false;
  const expected = sign(share, Number(expiresAt));
  const given = Buffer.from(signature ?? '', 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
