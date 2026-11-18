import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CHUNK_SIZE, decryptChunk, deriveShareKeys, encryptedSize, fromBase64 } from '../src/lib/crypto.js';
import { EXPIRY_OPTIONS, uploadShare } from '../src/lib/upload.js';
import { bytesOf, sameBytes } from './helpers.js';

// The API module is replaced with an in-memory server that records what it is sent.
const server = vi.hoisted(() => ({ manifest: null, bodies: {}, completed: false, progress: [] }));
vi.mock('../src/lib/api.js', () => ({
  createShare: vi.fn(async (manifest) => {
    server.manifest = manifest;
    return { code: '123456', uploadToken: 'tok', files: manifest.files.map((_, i) => ({ id: `f${i}` })) };
  }),
  uploadFile: vi.fn(async (code, fileId, body, token) => {
    expect([code, token]).toEqual(['123456', 'tok']);
    server.bodies[fileId] = body;
    return {};
  }),
  getUploadProgress: vi.fn(async () => server.progress.shift() ?? { received: 0, total: 100 }),
  completeShare: vi.fn(async () => {
    server.completed = true;
    return { code: '123456', expiresAt: '2030-01-01T00:00:00.000Z', burnAfterDownload: false };
  }),
}));

// Full-strength key derivation is slow; the iteration count does not change the logic.
vi.mock('../src/lib/crypto.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, deriveShareKeys: (password, salt, iterations = 1000) => real.deriveShareKeys(password, salt, iterations) };
});

const api = await import('../src/lib/api.js');

beforeEach(() => {
  Object.assign(server, { manifest: null, bodies: {}, completed: false, progress: [] });
});

const files = () => [
  new File(['hello world'], 'hello.txt', { type: 'text/plain' }),
  new File([new Uint8Array(10)], 'zeros.bin', { type: '' }),
];

describe('uploadShare without a password', () => {
  test('creates the share, uploads each file unchanged, then completes it', async () => {
    const picked = files();
    const result = await uploadShare({ files: picked, expiry: '7 days' });
    expect(result).toEqual({ code: '123456', expiresAt: '2030-01-01T00:00:00.000Z', burnAfterDownload: false });
    expect(server.manifest).toEqual({
      files: [{ name: 'hello.txt', size: 11, type: 'text/plain' }, { name: 'zeros.bin', size: 10, type: '' }],
      expiry: { type: 'in', hours: 168 },
    });
    expect(server.bodies.f0).toBe(picked[0]);
    expect(server.bodies.f1).toBe(picked[1]);
    expect(server.completed).toBe(true);
  });

  test('uploads one file at a time, in order', async () => {
    await uploadShare({ files: files(), expiry: '1 hour' });
    expect(api.uploadFile.mock.calls.map((call) => call[1])).toEqual(['f0', 'f1']);
  });

  test('ends by reporting 100% uploaded', async () => {
    const onProgress = vi.fn();
    await uploadShare({ files: files(), expiry: '1 hour', onProgress });
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'uploading', percent: 100 });
    expect(onProgress.mock.calls.every(([p]) => p.phase === 'uploading')).toBe(true);
  });
});

describe('expiry', () => {
  test('offers the choices the dialog shows', () => {
    expect(EXPIRY_OPTIONS).toEqual(['1 hour', '1 day', '7 days', '30 days', 'After first download', 'Custom date']);
  });

  test.each([
    ['1 hour', { type: 'in', hours: 1 }],
    ['1 day', { type: 'in', hours: 24 }],
    ['7 days', { type: 'in', hours: 168 }],
    ['30 days', { type: 'in', hours: 720 }],
    ['After first download', { type: 'first-download' }],
  ])('%s', async (expiry, expected) => {
    await uploadShare({ files: files(), expiry });
    expect(server.manifest.expiry).toEqual(expected);
  });

  test('a custom date runs to the end of that day, local time', async () => {
    await uploadShare({ files: files(), expiry: 'Custom date', customDate: '2030-06-15' });
    expect(server.manifest.expiry).toEqual({ type: 'date', date: new Date(2030, 5, 15, 23, 59, 59).toISOString() });
  });
});

describe('uploadShare with a password', () => {
  test('sends the key derivation and verifier, never the password or key', async () => {
    await uploadShare({ files: files(), expiry: '1 day', password: 'hunter2' });
    const { encryption } = server.manifest;
    expect(encryption.chunkSize).toBe(CHUNK_SIZE);
    expect(encryption.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-512' });
    expect(fromBase64(encryption.kdf.salt)).toHaveLength(16);
    expect(fromBase64(encryption.verifier)).toHaveLength(32);
    expect(JSON.stringify(server.manifest)).not.toContain('hunter2');
  });

  test('gives every file its own 8-byte nonce', async () => {
    await uploadShare({ files: files(), expiry: '1 day', password: 'pw' });
    const nonces = server.manifest.files.map((f) => f.nonce);
    expect(nonces.map((n) => fromBase64(n).length)).toEqual([8, 8]);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test('lists the original sizes but uploads ciphertext that the password decrypts', async () => {
    const picked = files();
    await uploadShare({ files: picked, expiry: '1 day', password: 'pw' });
    const { kdf } = server.manifest.encryption;
    const { key, verifier } = await deriveShareKeys('pw', fromBase64(kdf.salt), kdf.iterations);
    expect(verifier).toBe(server.manifest.encryption.verifier);

    for (const [i, file] of picked.entries()) {
      expect(server.manifest.files[i].size).toBe(file.size);
      const cipher = await bytesOf(server.bodies[`f${i}`]);
      expect(cipher.length).toBe(encryptedSize(file.size));
      const plain = await decryptChunk(key, fromBase64(server.manifest.files[i].nonce), 0, true, cipher);
      expect(sameBytes(new Uint8Array(plain), await bytesOf(file))).toBe(true);
    }
  });

  test('reports encrypting before uploading each file', async () => {
    const phases = [];
    await uploadShare({ files: files(), expiry: '1 day', password: 'pw', onProgress: (p) => phases.push(p.phase) });
    const changes = phases.filter((p, i) => p !== phases[i - 1]);
    expect(changes).toEqual(['encrypting', 'uploading', 'encrypting', 'uploading']);
  });
});

describe('progress polling', () => {
  test('reports the share of bytes the server has, never going backwards', async () => {
    vi.useFakeTimers();
    try {
      let release;
      api.uploadFile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      server.progress = [{ received: 30, total: 100 }, { received: 10, total: 100 }, { received: 75, total: 100 }];
      const seen = [];
      const done = uploadShare({ files: files().slice(0, 1), expiry: '1 hour', onProgress: (p) => seen.push(p.percent) });
      await vi.advanceTimersByTimeAsync(650);
      expect(seen.filter((p, i) => p !== seen[i - 1])).toEqual([0, 30, 75]);
      release({});
      await done;
      expect(seen.at(-1)).toBe(100);
      // Polling stops once the upload is over.
      const polls = api.getUploadProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.getUploadProgress.mock.calls.length).toBe(polls);
    } finally {
      vi.useRealTimers();
    }
  });

  test('stops polling when the upload fails', async () => {
    vi.useFakeTimers();
    try {
      api.uploadFile.mockRejectedValueOnce(new Error('network down'));
      await expect(uploadShare({ files: files(), expiry: '1 hour' })).rejects.toThrow('network down');
      const polls = api.getUploadProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.getUploadProgress.mock.calls.length).toBe(polls);
      expect(server.completed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
