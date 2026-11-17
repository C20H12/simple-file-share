import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { IN_ONE_HOUR, objectExists, readObject, readShareRecord, sleep, startTestServer } from './helpers.js';

let app;
before(async () => { app = await startTestServer(); });
after(() => app.close());

async function createShare(files, expiry = IN_ONE_HOUR) {
  const { status, body } = await app.api('/shares', { method: 'POST', json: { files, expiry } });
  assert.equal(status, 201);
  return body;
}
const put = (share, fileId, body, token = share.uploadToken) =>
  app.api(`/shares/${share.code}/files/${fileId}`, { method: 'PUT', token, body });
const progress = (share, token = share.uploadToken) => app.api(`/shares/${share.code}/progress`, { token });
const complete = (share, token = share.uploadToken) => app.api(`/shares/${share.code}/complete`, { method: 'POST', token });

describe('PUT /api/shares/:code/files/:fileId', () => {
  test('stores the uploaded bytes unchanged', async () => {
    const content = randomBytes(300_000);
    const share = await createShare([{ name: 'data.bin', size: content.length }]);
    const { status } = await put(share, share.files[0].id, content);
    assert.equal(status, 204);
    assert.ok((await readObject(`files/${share.code}/${share.files[0].id}`)).equals(content));
  });

  test('stores an empty file', async () => {
    const share = await createShare([{ name: 'empty', size: 0 }]);
    assert.equal((await put(share, share.files[0].id, Buffer.alloc(0))).status, 204);
    assert.equal((await readObject(`files/${share.code}/${share.files[0].id}`)).length, 0);
  });

  test('lets a file be uploaded again before the share is complete', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    await put(share, share.files[0].id, Buffer.from('first'));
    assert.equal((await put(share, share.files[0].id, Buffer.from('again'))).status, 204);
    assert.equal((await readObject(`files/${share.code}/${share.files[0].id}`)).toString(), 'again');
  });

  test('rejects a body that is not the declared size', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    assert.equal((await put(share, share.files[0].id, Buffer.from('too long'))).status, 400);
    assert.equal(await objectExists(`files/${share.code}/${share.files[0].id}`), false);
  });

  test('rejects a missing or wrong upload token with 401', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    const other = await createShare([{ name: 'b.txt', size: 5 }]);
    assert.equal((await put(share, share.files[0].id, Buffer.from('hello'), null)).status, 401);
    assert.equal((await put(share, share.files[0].id, Buffer.from('hello'), 'wrong')).status, 401);
    assert.equal((await put(share, share.files[0].id, Buffer.from('hello'), other.uploadToken)).status, 401);
  });

  test('returns 404 for an unknown share, a malformed code or an unknown file', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    const body = Buffer.from('hello');
    assert.equal((await app.api('/shares/000000/files/x', { method: 'PUT', token: share.uploadToken, body })).status, 404);
    assert.equal((await app.api('/shares/abc/files/x', { method: 'PUT', token: share.uploadToken, body })).status, 404);
    assert.equal((await put(share, 'not-a-file-id', body)).status, 404);
  });

  test('recovers when the client disconnects mid-upload', async () => {
    const share = await createShare([{ name: 'big.bin', size: 1_000_000 }]);
    const req = http.request(`${app.url}/api/shares/${share.code}/files/${share.files[0].id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${share.uploadToken}`, 'Content-Length': 1_000_000 },
    });
    req.on('error', () => {});
    req.write(Buffer.alloc(1000));
    await sleep(200);
    req.destroy();
    await sleep(300);

    assert.equal((await progress(share)).body.received, 0);
    assert.equal(await objectExists(`files/${share.code}/${share.files[0].id}`), false);
    // The same file can still be uploaded afterwards.
    assert.equal((await put(share, share.files[0].id, Buffer.alloc(1_000_000))).status, 204);
  });
});

describe('GET /api/shares/:code/progress', () => {
  test('starts at zero for every file', async () => {
    const share = await createShare([{ name: 'a', size: 10 }, { name: 'b', size: 30 }]);
    const { status, body } = await progress(share);
    assert.equal(status, 200);
    assert.deepEqual({ status: body.status, received: body.received, total: body.total }, { status: 'pending', received: 0, total: 40 });
    assert.deepEqual(body.files.map((f) => [f.received, f.size]), [[0, 10], [0, 30]]);
  });

  test('reports bytes as they arrive during an upload', async () => {
    const size = 900_000;
    const share = await createShare([{ name: 'slow.bin', size }]);
    const req = http.request(`${app.url}/api/shares/${share.code}/files/${share.files[0].id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${share.uploadToken}`, 'Content-Length': size },
    });
    const responded = new Promise((resolve, reject) => req.on('response', (res) => resolve(res.statusCode)).on('error', reject));

    req.write(Buffer.alloc(size / 3));
    await sleep(250);
    assert.equal((await progress(share)).body.received, size / 3);
    req.write(Buffer.alloc(size / 3));
    await sleep(250);
    assert.equal((await progress(share)).body.received, (size / 3) * 2);
    req.end(Buffer.alloc(size / 3));

    assert.equal(await responded, 204);
    assert.equal((await progress(share)).body.received, size);
  });

  test('tracks each file separately', async () => {
    const share = await createShare([{ name: 'a', size: 4 }, { name: 'b', size: 6 }]);
    await put(share, share.files[1].id, Buffer.alloc(6));
    const { body } = await progress(share);
    assert.equal(body.received, 6);
    assert.deepEqual(body.files.map((f) => f.received), [0, 6]);
  });

  test('requires the upload token', async () => {
    const share = await createShare([{ name: 'a', size: 4 }]);
    assert.equal((await progress(share, null)).status, 401);
    assert.equal((await progress(share, 'wrong')).status, 401);
  });
});

describe('POST /api/shares/:code/complete', () => {
  test('marks the share ready and starts the expiry clock', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }], { type: 'in', hours: 24 });
    await put(share, share.files[0].id, Buffer.from('hello'));
    const { status, body } = await complete(share);
    assert.equal(status, 200);
    assert.equal(body.code, share.code);
    assert.equal(body.passwordProtected, false);
    assert.equal(body.burnAfterDownload, false);
    assert.ok(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 24 * 3600_000)) < 5000);

    const record = await readShareRecord(share.code);
    assert.equal(record.status, 'ready');
    assert.equal(record.expiresAt, body.expiresAt);
    assert.deepEqual((await progress(share)).body.received, 5);
  });

  test('uses the chosen date as the expiry', async () => {
    const date = new Date(Date.now() + 3 * 864e5).toISOString();
    const share = await createShare([{ name: 'a.txt', size: 5 }], { type: 'date', date });
    await put(share, share.files[0].id, Buffer.from('hello'));
    assert.equal((await complete(share)).body.expiresAt, date);
  });

  test('keeps a first-download share for at most 30 days', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }], { type: 'first-download' });
    await put(share, share.files[0].id, Buffer.from('hello'));
    const { body } = await complete(share);
    assert.equal(body.burnAfterDownload, true);
    assert.ok(Math.abs(Date.parse(body.expiresAt) - (Date.now() + 30 * 864e5)) < 5000);
  });

  test('refuses with 409 and lists the files still missing', async () => {
    const share = await createShare([{ name: 'a', size: 4 }, { name: 'b', size: 6 }]);
    await put(share, share.files[0].id, Buffer.alloc(4));
    const { status, body } = await complete(share);
    assert.equal(status, 409);
    assert.deepEqual(body.missing, [share.files[1].id]);
    assert.equal((await readShareRecord(share.code)).status, 'pending');
  });

  test('is safe to call twice', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    await put(share, share.files[0].id, Buffer.from('hello'));
    const first = await complete(share);
    const second = await complete(share);
    assert.equal(second.status, 200);
    assert.equal(second.body.expiresAt, first.body.expiresAt);
  });

  test('blocks further uploads once complete', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    await put(share, share.files[0].id, Buffer.from('hello'));
    await complete(share);
    assert.equal((await put(share, share.files[0].id, Buffer.from('HELLO'))).status, 409);
    assert.equal((await readObject(`files/${share.code}/${share.files[0].id}`)).toString(), 'hello');
  });

  test('requires the upload token', async () => {
    const share = await createShare([{ name: 'a.txt', size: 5 }]);
    assert.equal((await complete(share, null)).status, 401);
  });
});
