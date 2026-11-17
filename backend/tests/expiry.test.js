import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { objectExists, sleep, startTestServer } from './helpers.js';

// helpers.js runs the sweeper every 200 ms for these tests.
let app;
before(async () => { app = await startTestServer(); });
after(() => app.close());

test('an expired share is deleted along with its files', async () => {
  const date = new Date(Date.now() + 1500).toISOString();
  const { body: share } = await app.api('/shares', { method: 'POST', json: { files: [{ name: 'a.txt', size: 5 }], expiry: { type: 'date', date } } });
  const fileKey = `files/${share.code}/${share.files[0].id}`;
  const token = share.uploadToken;

  await app.api(`/shares/${share.code}/files/${share.files[0].id}`, { method: 'PUT', token, body: Buffer.from('hello') });
  assert.equal((await app.api(`/shares/${share.code}/complete`, { method: 'POST', token })).status, 200);
  assert.equal(await objectExists(fileKey), true);

  await sleep(2500);

  assert.equal(await objectExists(fileKey), false);
  assert.equal(await objectExists(`meta/${share.code}.json`), false);
  assert.equal((await app.api(`/shares/${share.code}/progress`, { token })).status, 404);
});

test('a share that has not expired is left alone', async () => {
  const { body: share } = await app.api('/shares', { method: 'POST', json: { files: [{ name: 'a.txt', size: 5 }], expiry: { type: 'in', hours: 1 } } });
  await sleep(600); // several sweeps
  assert.equal(await objectExists(`meta/${share.code}.json`), true);
  assert.equal((await app.api(`/shares/${share.code}/progress`, { token: share.uploadToken })).status, 200);
});
