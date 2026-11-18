import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { IN_ONE_HOUR, config, encryptionParams, readShareRecord, startTestServer } from './helpers.js';
import { verifySecret } from '../src/password.js';
import { formatBytes } from '../src/routes/upload.js';

let app;
before(async () => { app = await startTestServer(); });
after(() => app.close());

const create = (json) => app.api('/shares', { method: 'POST', json });
const oneFile = [{ name: 'a.txt', size: 5, type: 'text/plain' }];

describe('POST /api/shares', () => {
  test('creates a pending share with a code, upload token and file ids', async () => {
    const { status, body } = await create({ files: oneFile, expiry: IN_ONE_HOUR });
    assert.equal(status, 201);
    assert.match(body.code, /^\d{6}$/);
    assert.ok(body.uploadToken.length >= 32);
    assert.deepEqual(body.files.map(({ name, size, storedSize }) => ({ name, size, storedSize })), [{ name: 'a.txt', size: 5, storedSize: 5 }]);
    assert.ok(body.files[0].id);

    const record = await readShareRecord(body.code);
    assert.equal(record.status, 'pending');
    assert.equal(record.password, null);
    assert.equal(record.burnAfterDownload, false);
  });

  test('does not store the upload token itself', async () => {
    const { body } = await create({ files: oneFile, expiry: IN_ONE_HOUR });
    assert.ok(!JSON.stringify(await readShareRecord(body.code)).includes(body.uploadToken));
  });

  test('gives each share a different code', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create({ files: oneFile, expiry: IN_ONE_HOUR })));
    assert.equal(new Set(results.map((r) => r.body.code)).size, 5);
  });

  test('flags a share that expires after the first download', async () => {
    const { body } = await create({ files: oneFile, expiry: { type: 'first-download' } });
    assert.equal((await readShareRecord(body.code)).burnAfterDownload, true);
  });

  describe('expiry validation', () => {
    const cases = {
      'missing expiry': undefined,
      'unknown type': { type: 'never' },
      'duration not offered in the UI': { type: 'in', hours: 5 },
      '30 days, no longer offered': { type: 'in', hours: 720 },
      'unparseable date': { type: 'date', date: 'tomorrow-ish' },
      'date in the past': { type: 'date', date: '2020-01-01T00:00:00Z' },
      'date more than a year away': { type: 'date', date: new Date(Date.now() + 400 * 864e5).toISOString() },
    };
    for (const [name, expiry] of Object.entries(cases)) {
      test(`rejects ${name}`, async () => {
        assert.equal((await create({ files: oneFile, expiry })).status, 400);
      });
    }

    test('accepts each offered duration and a future date', async () => {
      for (const hours of [1, 12, 24, 168]) {
        assert.equal((await create({ files: oneFile, expiry: { type: 'in', hours } })).status, 201);
      }
      const date = new Date(Date.now() + 864e5).toISOString();
      assert.equal((await create({ files: oneFile, expiry: { type: 'date', date } })).status, 201);
    });
  });

  describe('file validation', () => {
    const cases = {
      'no files field': undefined,
      'an empty file list': [],
      'a file without a name': [{ size: 1 }],
      'an empty name': [{ name: '', size: 1 }],
      'a name over 255 characters': [{ name: 'x'.repeat(256), size: 1 }],
      'a negative size': [{ name: 'a', size: -1 }],
      'a fractional size': [{ name: 'a', size: 1.5 }],
      'a size given as text': [{ name: 'a', size: '5' }],
      'more than 100 files': Array.from({ length: 101 }, (_, i) => ({ name: `f${i}`, size: 1 })),
    };
    for (const [name, files] of Object.entries(cases)) {
      test(`rejects ${name}`, async () => {
        assert.equal((await create({ files, expiry: IN_ONE_HOUR })).status, 400);
      });
    }

    test('rejects a share over the size limit with 413', async () => {
      const files = [{ name: 'a', size: 1024 ** 3 }, { name: 'b', size: 1024 ** 3 + 1 }];
      assert.equal((await create({ files, expiry: IN_ONE_HOUR })).status, 413);
    });

    test('accepts an empty file', async () => {
      assert.equal((await create({ files: [{ name: 'empty', size: 0 }], expiry: IN_ONE_HOUR })).status, 201);
    });
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await fetch(`${app.url}/api/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
  });

  describe('password protection', () => {
    const nonce = Buffer.alloc(8, 3).toString('base64');
    const protectedFiles = (size) => [{ name: 'secret.pdf', size, nonce }];

    test('stores only a hash of the verifier, plus what receivers need to derive the key', async () => {
      const encryption = encryptionParams();
      const { status, body } = await create({ files: protectedFiles(10), expiry: IN_ONE_HOUR, encryption });
      assert.equal(status, 201);

      const record = await readShareRecord(body.code);
      assert.ok(!JSON.stringify(record).includes(encryption.verifier));
      assert.equal(record.password.verifierHash.alg, 'scrypt');
      assert.deepEqual(record.password.kdf, encryption.kdf);
      assert.equal(record.password.chunkSize, encryption.chunkSize);
      assert.equal(record.files[0].nonce, nonce);

      const verifier = Buffer.from(encryption.verifier, 'base64');
      assert.equal(await verifySecret(verifier, record.password.verifierHash), true);
      assert.equal(await verifySecret(Buffer.alloc(32, 9), record.password.verifierHash), false);
    });

    test('adds one 16-byte tag per chunk to the stored size', async () => {
      const chunkSize = 64 * 1024;
      const sizes = { 0: 16, 1: 17, [chunkSize]: chunkSize + 16, [chunkSize + 1]: chunkSize + 1 + 32 };
      for (const [size, expected] of Object.entries(sizes)) {
        const { body } = await create({ files: protectedFiles(Number(size)), expiry: IN_ONE_HOUR, encryption: encryptionParams({ chunkSize }) });
        assert.equal(body.files[0].storedSize, expected, `size ${size}`);
      }
    });

    const badEncryption = {
      'a different key derivation': { kdf: { ...encryptionParams().kdf, name: 'scrypt' } },
      'too few iterations': { kdf: { ...encryptionParams().kdf, iterations: 1000 } },
      'a short salt': { kdf: { ...encryptionParams().kdf, salt: 'AAAA' } },
      'a short verifier': { verifier: 'AAAA' },
      'a missing verifier': { verifier: undefined },
      'a tiny chunk size': { chunkSize: 16 },
    };
    for (const [name, overrides] of Object.entries(badEncryption)) {
      test(`rejects ${name}`, async () => {
        const res = await create({ files: protectedFiles(10), expiry: IN_ONE_HOUR, encryption: encryptionParams(overrides) });
        assert.equal(res.status, 400);
      });
    }

    test('requires a nonce on every file', async () => {
      const res = await create({ files: [{ name: 'secret.pdf', size: 10 }], expiry: IN_ONE_HOUR, encryption: encryptionParams() });
      assert.equal(res.status, 400);
    });
  });
});

test('unknown API routes return a JSON 404', async () => {
  const { status, body } = await app.api('/nope');
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('GET /health reports storage is up', async () => {
  const res = await fetch(`${app.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, storage: 'up' });
});

describe('share size limit', () => {
  const { maxBytes } = config.shares;
  const nonce = Buffer.alloc(8, 3).toString('base64');

  test('is 50 MB by default', () => {
    assert.equal(maxBytes, 50_000_000);
  });

  test('accepts files adding up to exactly the limit', async () => {
    const { status } = await create({
      files: [{ name: 'a.bin', size: maxBytes - 1000 }, { name: 'b.bin', size: 1000 }],
      expiry: IN_ONE_HOUR,
    });
    assert.equal(status, 201);
  });

  test('refuses one byte more with 413, saying how much in MB', async () => {
    const { status, body } = await create({
      files: [{ name: 'a.bin', size: maxBytes - 1000 }, { name: 'b.bin', size: 1001 }],
      expiry: IN_ONE_HOUR,
    });
    assert.equal(status, 413);
    assert.equal(body.error, 'these files add up to 50 MB; a share can hold at most 50 MB');
    assert.equal(body.maxBytes, maxBytes);
  });

  test('names the total in the right unit', async () => {
    const { body } = await create({ files: [{ name: 'big.iso', size: 4_700_000_000 }], expiry: IN_ONE_HOUR });
    assert.equal(body.error, 'these files add up to 4.7 GB; a share can hold at most 50 MB');
  });

  test('counts the files as picked, not the encryption overhead', async () => {
    const { status, body } = await create({
      files: [{ name: 'secret.bin', size: maxBytes, nonce }],
      expiry: IN_ONE_HOUR,
      encryption: encryptionParams(),
    });
    assert.equal(status, 201);
    assert.ok(body.files[0].storedSize > maxBytes);
  });
});

describe('formatBytes', () => {
  test('uses decimal units and drops a trailing .0', () => {
    assert.equal(formatBytes(50_000_000), '50 MB');
    assert.equal(formatBytes(52_428_800), '52.4 MB');
    assert.equal(formatBytes(2_147_483_648), '2.1 GB');
    assert.equal(formatBytes(1500), '1.5 KB');
    assert.equal(formatBytes(999), '999 bytes');
  });
});
