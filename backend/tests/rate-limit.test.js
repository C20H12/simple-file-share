import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { config, createReadyShare, encryptionParams, sleep, startTestServer } from './helpers.js';

// Short windows so each test starts with a clean slate.
const WINDOW_MS = 400;
let app;
before(async () => {
  Object.assign(config.limits, { windowMs: WINDOW_MS, lookupMisses: 3, unlockFailures: 2 });
  app = await startTestServer();
});
after(() => app.close());
beforeEach(() => sleep(WINDOW_MS + 50));

const lookup = (code) => app.api(`/shares/${code}`);
const unlock = (code, verifier) => app.api(`/shares/${code}/unlock`, { method: 'POST', json: { verifier } });
const WRONG = Buffer.alloc(32, 9).toString('base64');

test('guessing codes is cut off after the allowed number of misses', async () => {
  const share = await createReadyShare(app, [{ name: 'a.txt', content: Buffer.from('hello') }]);
  for (let i = 0; i < 3; i++) assert.equal((await lookup(`00000${i}`)).status, 404);

  const res = await fetch(`${app.url}/api/shares/000009`);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.ok((await res.json()).retryAfter >= 1);
  // While cut off, the client learns nothing about real codes either.
  assert.equal((await lookup(share.code)).status, 429);
  assert.equal((await app.api(`/shares/${share.code}/progress`, { token: share.uploadToken })).status, 429);

  await sleep(WINDOW_MS + 50);
  assert.equal((await lookup(share.code)).status, 200);
});

test('requests for shares that exist never count as misses', async () => {
  const share = await createReadyShare(app, [{ name: 'a.txt', content: Buffer.from('hello') }]);
  for (let i = 0; i < 10; i++) assert.equal((await lookup(share.code)).status, 200);
});

test('password guessing is cut off per share, even for the right password', async () => {
  const encryption = encryptionParams();
  const content = [{ name: 'secret.pdf', content: randomBytes(100) }];
  const share = await createReadyShare(app, content, { encryption });
  const other = await createReadyShare(app, content, { encryption });

  assert.equal((await unlock(share.code, WRONG)).status, 401);
  assert.equal((await unlock(share.code, WRONG)).status, 401);
  const blocked = await unlock(share.code, encryption.verifier);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.retryAfter >= 1);
  assert.equal(blocked.body.accessToken, undefined);

  // Other shares are unaffected, and this one recovers after the window.
  assert.equal((await unlock(other.code, encryption.verifier)).status, 200);
  await sleep(WINDOW_MS + 50);
  assert.equal((await unlock(share.code, encryption.verifier)).status, 200);
});

test('a correct password does not use up attempts', async () => {
  const encryption = encryptionParams();
  const share = await createReadyShare(app, [{ name: 'secret.pdf', content: randomBytes(100) }], { encryption });
  for (let i = 0; i < 5; i++) assert.equal((await unlock(share.code, encryption.verifier)).status, 200);
});
