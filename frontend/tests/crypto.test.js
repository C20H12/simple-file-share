import { describe, expect, test } from 'vitest';
import {
  CHUNK_SIZE, decryptChunk, deriveShareKeys, encryptFile, encryptedSize, fromBase64, randomBytes, toBase64,
} from '../src/lib/crypto.js';
import { bytesOf, pattern, sameBytes, split } from './helpers.js';

// Key derivation at full strength takes a noticeable fraction of a second;
// most tests use a few iterations, which exercises exactly the same code.
const FAST = 1000;
const keysFor = (password, salt = new Uint8Array(16).fill(7)) => deriveShareKeys(password, salt, FAST);

// Decrypts what encryptFile produced, chunk by chunk.
async function decryptAll(cipher, key, nonce, size) {
  const count = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const parts = split(cipher, CHUNK_SIZE + 16);
  expect(parts.length).toBe(count);
  const plain = [];
  for (const [i, part] of parts.entries()) plain.push(new Uint8Array(await decryptChunk(key, nonce, i, i === count - 1, part)));
  return Buffer.concat(plain);
}

describe('base64', () => {
  test('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  test('matches the standard encoding', () => {
    expect(toBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });
});

describe('randomBytes', () => {
  test('returns the requested number of bytes, different each time', () => {
    const a = randomBytes(16);
    expect(a).toHaveLength(16);
    expect(a).not.toEqual(randomBytes(16));
  });
});

describe('encryptedSize', () => {
  test('adds a 16-byte tag per chunk', () => {
    expect(encryptedSize(0)).toBe(16); // an empty file is one empty chunk
    expect(encryptedSize(1)).toBe(17);
    expect(encryptedSize(CHUNK_SIZE)).toBe(CHUNK_SIZE + 16);
    expect(encryptedSize(CHUNK_SIZE + 1)).toBe(CHUNK_SIZE + 1 + 32);
  });
});

describe('deriveShareKeys', () => {
  test('describes the derivation so a receiver can repeat it', async () => {
    const salt = randomBytes(16);
    const { kdf } = await deriveShareKeys('pw', salt, FAST);
    expect(kdf).toEqual({ name: 'PBKDF2', hash: 'SHA-512', iterations: FAST, salt: toBase64(salt) });
  });

  test('defaults to a fresh salt and 210,000 iterations', async () => {
    const a = await deriveShareKeys('pw');
    const b = await deriveShareKeys('pw');
    expect(a.kdf.iterations).toBe(210_000);
    expect(fromBase64(a.kdf.salt)).toHaveLength(16);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.verifier).not.toBe(b.verifier);
  });

  test('the same password and salt give the same verifier and key', async () => {
    const sender = await keysFor('correct horse');
    const receiver = await keysFor('correct horse');
    expect(receiver.verifier).toBe(sender.verifier);
    const nonce = randomBytes(8);
    const cipher = await encryptFile(new Blob(['secret']), sender.key, nonce);
    expect(new TextDecoder().decode(await decryptAll(await bytesOf(cipher), receiver.key, nonce, 6))).toBe('secret');
  });

  test('a different password or salt gives a different verifier', async () => {
    const base = await keysFor('pw');
    expect((await keysFor('pw2')).verifier).not.toBe(base.verifier);
    expect((await keysFor('pw', new Uint8Array(16).fill(8))).verifier).not.toBe(base.verifier);
  });

  test('the verifier is 32 bytes and the key cannot be exported', async () => {
    const { key, verifier } = await keysFor('pw');
    expect(fromBase64(verifier)).toHaveLength(32);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
  });
});

describe('encryptFile / decryptChunk', () => {
  const nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  for (const size of [0, 1, 1000, CHUNK_SIZE, CHUNK_SIZE + 1, 2 * CHUNK_SIZE + 12345]) {
    test(`round-trips a ${size}-byte file`, async () => {
      const { key } = await keysFor('pw');
      const plain = pattern(size);
      const cipher = await bytesOf(await encryptFile(new Blob([plain]), key, nonce));
      expect(cipher.length).toBe(encryptedSize(size));
      expect(sameBytes(await decryptAll(cipher, key, nonce, size), plain)).toBe(true);
    });
  }

  test('reports progress after each chunk and returns an octet-stream Blob', async () => {
    const { key } = await keysFor('pw');
    const seen = [];
    const blob = await encryptFile(new Blob([pattern(CHUNK_SIZE + 10)]), key, nonce, { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([CHUNK_SIZE, CHUNK_SIZE + 10]);
    expect(blob.type).toBe('application/octet-stream');
  });

  test('stops when aborted', async () => {
    const { key } = await keysFor('pw');
    const controller = new AbortController();
    controller.abort();
    await expect(encryptFile(new Blob(['x']), key, nonce, { signal: controller.signal })).rejects.toThrow();
  });

  test('the wrong key fails to decrypt', async () => {
    const cipher = await bytesOf(await encryptFile(new Blob(['secret']), (await keysFor('pw')).key, nonce));
    await expect(decryptChunk((await keysFor('nope')).key, nonce, 0, true, cipher)).rejects.toThrow();
  });

  test('altered ciphertext fails to decrypt', async () => {
    const { key } = await keysFor('pw');
    const cipher = await bytesOf(await encryptFile(new Blob(['secret']), key, nonce));
    cipher[0] ^= 1;
    await expect(decryptChunk(key, nonce, 0, true, cipher)).rejects.toThrow();
  });

  test('a chunk only decrypts at its own position, so chunks cannot be reordered', async () => {
    const { key } = await keysFor('pw');
    const cipher = await bytesOf(await encryptFile(new Blob([pattern(CHUNK_SIZE + 5)]), key, nonce));
    const [first] = split(cipher, CHUNK_SIZE + 16);
    await expect(decryptChunk(key, nonce, 1, true, first)).rejects.toThrow();
  });

  test('a file cut short after a whole chunk fails: the last chunk is marked', async () => {
    const { key } = await keysFor('pw');
    const cipher = await bytesOf(await encryptFile(new Blob([pattern(CHUNK_SIZE + 5)]), key, nonce));
    const [first] = split(cipher, CHUNK_SIZE + 16);
    // Pretending the first chunk is the last one, as a truncated download would.
    await expect(decryptChunk(key, nonce, 0, true, first)).rejects.toThrow();
    await expect(decryptChunk(key, nonce, 0, false, first)).resolves.toBeDefined();
  });

  test('the same file under another nonce encrypts differently', async () => {
    const { key } = await keysFor('pw');
    const a = await bytesOf(await encryptFile(new Blob(['same']), key, nonce));
    const b = await bytesOf(await encryptFile(new Blob(['same']), key, new Uint8Array(8)));
    expect(sameBytes(a, b)).toBe(false);
  });
});
