import assert from 'node:assert/strict';
import { after, afterEach, before, describe, mock, test } from 'node:test';
import { IN_ONE_HOUR, config, createReadyShare, download, eventually, objectExists, shares, startTestServer, storage } from './helpers.js';

const { deleteShare, loadIndex, releaseSpace, storedBytes } = shares;

// Each test file runs in its own process with its own bucket, so the storage
// budget here only counts what these tests create. It is set per test.
let app;
before(async () => { app = await startTestServer(); });
after(() => app.close());

const defaultCap = config.shares.storageMaxBytes;
afterEach(() => { config.shares.storageMaxBytes = defaultCap; });

const create = (files, expiry = IN_ONE_HOUR) => app.api('/shares', { method: 'POST', json: { files, expiry } });
const STORAGE_FULL = { error: 'the server is out of storage space; try again later', reason: 'storage-full' };

describe('storage budget', () => {
  test('is 3 GB by default', () => {
    assert.equal(defaultCap, 3_000_000_000);
  });

  test('refuses a share that does not fit with 507, before anything is stored', async () => {
    config.shares.storageMaxBytes = storedBytes() + 1000;
    const { status, body } = await create([{ name: 'big.bin', size: 1001 }]);
    assert.equal(status, 507);
    assert.deepEqual(body, STORAGE_FULL);
  });

  test('accepts a share that exactly fills it', async () => {
    config.shares.storageMaxBytes = storedBytes() + 1000;
    const { status } = await create([{ name: 'a.bin', size: 600 }, { name: 'b.bin', size: 400 }]);
    assert.equal(status, 201);
  });

  test('sets space aside when a share is created, before its upload', async () => {
    const before = storedBytes();
    config.shares.storageMaxBytes = before + 1000;
    assert.equal((await create([{ name: 'a.bin', size: 700 }])).status, 201); // not uploaded yet
    assert.equal(storedBytes(), before + 700);
    assert.equal((await create([{ name: 'b.bin', size: 400 }])).status, 507);
    assert.equal((await create([{ name: 'c.bin', size: 300 }])).status, 201);
  });

  test('gives the space back when a share is deleted', async () => {
    const before = storedBytes();
    config.shares.storageMaxBytes = before + 500;
    const { body } = await create([{ name: 'a.bin', size: 500 }]);
    assert.equal((await create([{ name: 'b.bin', size: 1 }])).status, 507);
    await deleteShare(body.code);
    assert.equal(storedBytes(), before);
    assert.equal((await create([{ name: 'b.bin', size: 500 }])).status, 201);
  });

  test('gives a one-time file\'s space back once it is downloaded', async () => {
    const share = await createReadyShare(app, [
      { name: 'a.txt', content: Buffer.from('first file') },
      { name: 'b.txt', content: Buffer.from('second') },
    ], { expiry: { type: 'first-download' } });
    const before = storedBytes();
    assert.equal((await download(app, share.code, share.files[0].id)).status, 200);
    await eventually(() => storedBytes() === before - 10);
    assert.equal((await download(app, share.code, share.files[1].id)).status, 200);
    await eventually(() => storedBytes() === before - 16); // last file: the whole share is gone
  });

  test('is rebuilt from storage on startup', async () => {
    const share = await createReadyShare(app, [{ name: 'a.txt', content: Buffer.from('hello') }]);
    const before = storedBytes();
    releaseSpace(share.code); // as if the server had just started and knew nothing
    assert.equal(storedBytes(), before - 5);
    await loadIndex();
    assert.equal(storedBytes(), before);
  });
});

describe('storage refusing a write', () => {
  test('a MinIO quota error during an upload is reported as storage full', async () => {
    const { body: share } = await create([{ name: 'a.txt', size: 5 }]);
    const refused = Object.assign(new Error('Bucket quota exceeded'), { code: 'XMinioAdminBucketQuotaExceeded' });
    const put = mock.method(storage, 'putObject', async () => { throw refused; });
    try {
      const res = await app.api(`/shares/${share.code}/files/${share.files[0].id}`, { method: 'PUT', token: share.uploadToken, body: Buffer.from('hello') });
      assert.equal(res.status, 507);
      assert.deepEqual(res.body, STORAGE_FULL);
    } finally {
      put.mock.restore();
    }
    assert.equal(await objectExists(`files/${share.code}/${share.files[0].id}`), false);
  });

  test('other storage failures stay internal errors', async () => {
    const { body: share } = await create([{ name: 'a.txt', size: 5 }]);
    const put = mock.method(storage, 'putObject', async () => { throw Object.assign(new Error('boom'), { code: 'InternalError' }); });
    const errorLog = mock.method(console, 'error', () => {});
    try {
      const res = await app.api(`/shares/${share.code}/files/${share.files[0].id}`, { method: 'PUT', token: share.uploadToken, body: Buffer.from('hello') });
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: 'internal error' });
    } finally {
      put.mock.restore();
      errorLog.mock.restore();
    }
  });
});
