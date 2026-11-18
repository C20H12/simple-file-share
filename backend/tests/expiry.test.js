import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { IN_ONE_HOUR, config, createReadyShare, eventually, expireIn, objectExists, sleep, startTestServer } from './helpers.js';

// helpers.js runs the sweeper every 200 ms for these tests.
let app;
before(async () => { app = await startTestServer(); });
after(() => app.close());

test('an expired share is deleted along with its files', async () => {
  const { body: share } = await app.api('/shares', { method: 'POST', json: { files: [{ name: 'a.txt', size: 5 }], expiry: IN_ONE_HOUR } });
  const fileKey = `files/${share.code}/${share.files[0].id}`;
  const token = share.uploadToken;

  await app.api(`/shares/${share.code}/files/${share.files[0].id}`, { method: 'PUT', token, body: Buffer.from('hello') });
  assert.equal((await app.api(`/shares/${share.code}/complete`, { method: 'POST', token })).status, 200);
  assert.equal(await objectExists(fileKey), true);
  await expireIn(share.code, 1500);

  await sleep(2500);

  assert.equal(await objectExists(fileKey), false);
  assert.equal(await objectExists(`meta/${share.code}.json`), false);
  assert.equal((await app.api(`/shares/${share.code}/progress`, { token })).status, 404);
  assert.equal((await app.api(`/shares/${share.code}`)).status, 404);
});

test('a download that began before expiry is allowed to finish', async () => {
  // Large enough that the download stays in progress while unread.
  const size = 32 * 1024 * 1024;
  const share = await createReadyShare(app, [{ name: 'big.bin', content: Buffer.alloc(size, 7) }]);
  share.expiresAt = await expireIn(share.code, 4000);
  const fileKey = `files/${share.code}/${share.files[0].id}`;

  const res = await new Promise((resolve, reject) => {
    http.get(`${app.url}/api/shares/${share.code}/files/${share.files[0].id}`, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 200);

  await sleep(Date.parse(share.expiresAt) - Date.now() + 800); // expired, several sweeps
  assert.equal((await app.api(`/shares/${share.code}`)).status, 404); // no new receivers
  assert.equal(await objectExists(fileKey), true); // but the file is still there

  let received = 0;
  for await (const chunk of res) received += chunk.length;
  assert.equal(received, size);
  await eventually(async () => !(await objectExists(fileKey)));
});

test('a download still running after the grace period is cut off and the share deleted', async () => {
  const graceMs = 2000;
  const defaultGrace = config.shares.downloadGraceMs;
  assert.equal(defaultGrace, 60 * 60_000); // one hour unless configured
  config.shares.downloadGraceMs = graceMs;
  try {
    const size = 32 * 1024 * 1024;
    const share = await createReadyShare(app, [{ name: 'big.bin', content: Buffer.alloc(size, 9) }]);
    const fileKey = `files/${share.code}/${share.files[0].id}`;
    const res = await new Promise((resolve, reject) => {
      http.get(`${app.url}/api/shares/${share.code}/files/${share.files[0].id}`, resolve).on('error', reject);
    });
    assert.equal(res.statusCode, 200);
    res.pause(); // a receiver that stalls

    const expiresAt = Date.parse(await expireIn(share.code, 200));
    await sleep(expiresAt + graceMs / 2 - Date.now()); // expired, still within the grace period
    assert.equal(await objectExists(fileKey), true);
    assert.equal((await app.api(`/shares/${share.code}`)).status, 404);

    await eventually(async () => !(await objectExists(fileKey)), graceMs + 3000);
    assert.equal(await objectExists(`meta/${share.code}.json`), false);

    // The receiver gets what was already in flight, then the connection ends short of the file.
    let received = 0;
    const ended = await new Promise((resolve) => {
      res.on('data', (chunk) => { received += chunk.length; });
      res.on('end', () => resolve('end'));
      res.on('aborted', () => resolve('aborted'));
      res.on('error', () => resolve('error'));
      res.on('close', () => resolve('close'));
      res.resume();
    });
    assert.ok(received < size, `received ${received} of ${size} bytes (${ended})`);
  } finally {
    config.shares.downloadGraceMs = defaultGrace;
  }
});

test('a share that has not expired is left alone', async () => {
  const { body: share } = await app.api('/shares', { method: 'POST', json: { files: [{ name: 'a.txt', size: 5 }], expiry: { type: 'in', hours: 1 } } });
  await sleep(600); // several sweeps
  assert.equal(await objectExists(`meta/${share.code}.json`), true);
  assert.equal((await app.api(`/shares/${share.code}/progress`, { token: share.uploadToken })).status, 200);
});
