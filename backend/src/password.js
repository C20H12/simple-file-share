import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const derive = (secret, salt, { N, r, p }) =>
  scryptAsync(secret, salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r });

// Hashes a share's password verifier for storage. Returns a self-describing
// record so the parameters can be raised later without breaking old shares.
export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = await derive(secret, salt, PARAMS);
  return { alg: 'scrypt', ...PARAMS, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export async function verifySecret(secret, record) {
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await derive(secret, Buffer.from(record.salt, 'base64'), record);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
