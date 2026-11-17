import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import {
  createReadyShare, download, encryptionParams, eventually, objectExists, startTestServer,
} from './helpers.js';

let app;
before(async () => { app = await startTestServer(); });
after(() => app.close());

const lookup = (code, token) => app.api(`/shares/${code}`, { token });
const unlock = (code, verifier) => app.api(`/shares/${code}/unlock`, { method: 'POST', json: { verifier } });
const hello = { name: 'hello.txt', content: Buffer.from('hello'), type: 'text/plain' };
const FIRST_DOWNLOAD = { type: 'first-download' };

// A password-protected share with one file. The server never decrypts, so any
// bytes of the right length stand in for the ciphertext.
async function createProtectedShare(files = [{ name: 'secret.pdf', content: randomBytes(1000) }]) {
  const encryption = encryptionParams();
  const share = await createReadyShare(app, files, { encryption });
  const unlocked = await unlock(share.code, encryption.verifier);
  return { share, encryption, token: unlocked.body.accessToken };
}

describe('GET /api/shares/:code', () => {
  test('returns the files and expiry of a share', async () => {
    const share = await createReadyShare(app, [hello, { name: 'data.bin', content: randomBytes(300) }]);
    const { status, body } = await lookup(share.code);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      code: share.code,
      expiresAt: share.expiresAt,
      burnAfterDownload: false,
      passwordProtected: false,
      encryption: null,
      files: [
        { id: share.files[0].id, name: 'hello.txt', size: 5, type: 'text/plain', storedSize: 5 },
        { id: share.files[1].id, name: 'data.bin', size: 300, type: '', storedSize: 300 },
      ],
    });
  });

  test('returns 404 for an unknown or malformed code', async () => {
    assert.equal((await lookup('000000')).status, 404);
    assert.equal((await lookup('12345')).status, 404);
    assert.equal((await lookup('abcdef')).status, 404);
  });

  test('hides a share that is still being uploaded', async () => {
    const { body: pending } = await app.api('/shares', { method: 'POST', json: { files: [{ name: 'a.txt', size: 5 }], expiry: { type: 'in', hours: 1 } } });
    assert.equal((await lookup(pending.code)).status, 404);
  });

  test('withholds the file list of a password-protected share', async () => {
    const encryption = encryptionParams();
    const share = await createReadyShare(app, [{ name: 'secret.pdf', content: randomBytes(100) }], { encryption });
    const { status, body } = await lookup(share.code);
    assert.equal(status, 200);
    assert.equal(body.passwordProtected, true);
    assert.equal(body.files, null);
    assert.deepEqual(body.encryption, { alg: 'AES-256-GCM', chunkSize: encryption.chunkSize, kdf: encryption.kdf });
  });

  test('includes the file list once the request carries an access token', async () => {
    const { share, token } = await createProtectedShare();
    const { body } = await lookup(share.code, token);
    assert.deepEqual(body.files.map((f) => f.name), ['secret.pdf']);
    assert.ok(body.files[0].nonce);
  });

  test('never exposes the upload token or the password verifier hash', async () => {
    const { share, encryption, token } = await createProtectedShare();
    for (const response of [await lookup(share.code), await lookup(share.code, token)]) {
      const text = JSON.stringify(response.body);
      assert.ok(!text.includes('verifierHash') && !text.includes('uploadToken'));
      assert.ok(!text.includes(encryption.verifier) && !text.includes(share.uploadToken));
    }
  });
});

describe('POST /api/shares/:code/unlock', () => {
  test('exchanges the right verifier for an access token and the file list', async () => {
    const encryption = encryptionParams();
    const share = await createReadyShare(app, [{ name: 'secret.pdf', content: randomBytes(100) }], { encryption });
    const { status, body } = await unlock(share.code, encryption.verifier);
    assert.equal(status, 200);
    assert.ok(body.accessToken);
    assert.ok(Date.parse(body.accessExpiresAt) > Date.now());
    assert.ok(Date.parse(body.accessExpiresAt) <= Date.parse(share.expiresAt));
    assert.deepEqual(body.files.map(({ name, size, storedSize }) => ({ name, size, storedSize })), [{ name: 'secret.pdf', size: 84, storedSize: 100 }]);
    assert.ok(body.files[0].nonce);
  });

  test('rejects a wrong verifier with 401', async () => {
    const { share } = await createProtectedShare();
    const { status, body } = await unlock(share.code, Buffer.alloc(32, 9).toString('base64'));
    assert.equal(status, 401);
    assert.equal(body.accessToken, undefined);
    assert.equal(body.files, undefined);
  });

  test('rejects a missing or malformed verifier with 400', async () => {
    const { share } = await createProtectedShare();
    assert.equal((await unlock(share.code, undefined)).status, 400);
    assert.equal((await unlock(share.code, 'AAAA')).status, 400);
    assert.equal((await unlock(share.code, 12345)).status, 400);
  });

  test('rejects a share that has no password with 400', async () => {
    const share = await createReadyShare(app, [hello]);
    assert.equal((await unlock(share.code, Buffer.alloc(32).toString('base64'))).status, 400);
  });

  test('returns 404 for an unknown code', async () => {
    assert.equal((await unlock('000000', Buffer.alloc(32).toString('base64'))).status, 404);
  });
});

describe('GET /api/shares/:code/files/:fileId', () => {
  test('returns the uploaded bytes', async () => {
    const content = randomBytes(300_000);
    const share = await createReadyShare(app, [{ name: 'data.bin', content }]);
    const { status, headers, bytes } = await download(app, share.code, share.files[0].id);
    assert.equal(status, 200);
    assert.equal(headers.get('content-length'), '300000');
    assert.ok(bytes.equals(content));
  });

  test('returns an empty file', async () => {
    const share = await createReadyShare(app, [{ name: 'empty', content: Buffer.alloc(0) }]);
    const { status, bytes } = await download(app, share.code, share.files[0].id);
    assert.equal(status, 200);
    assert.equal(bytes.length, 0);
  });

  test('can be downloaded any number of times', async () => {
    const share = await createReadyShare(app, [hello]);
    for (let i = 0; i < 3; i++) assert.equal((await download(app, share.code, share.files[0].id)).bytes.toString(), 'hello');
  });

  test('sends an HTML upload as an opaque attachment, not as a page', async () => {
    const page = { name: 'page.html', content: Buffer.from('<script>alert(1)</script>'), type: 'text/html' };
    const share = await createReadyShare(app, [page]);
    const { headers } = await download(app, share.code, share.files[0].id);
    assert.equal(headers.get('content-type'), 'application/octet-stream');
    assert.equal(headers.get('content-disposition'), 'attachment; filename=page.html');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('cache-control'), 'no-store');
  });

  test('carries a non-ASCII file name in the download header', async () => {
    const share = await createReadyShare(app, [{ name: 'résumé – 日本.pdf', content: Buffer.from('x') }]);
    const { status, headers } = await download(app, share.code, share.files[0].id);
    assert.equal(status, 200);
    assert.ok(headers.get('content-disposition').includes(`filename*=UTF-8''${encodeURIComponent('résumé – 日本.pdf')}`));
  });

  test('returns 404 for an unknown share or file', async () => {
    const share = await createReadyShare(app, [hello]);
    assert.equal((await download(app, '000000', share.files[0].id)).status, 404);
    assert.equal((await download(app, share.code, 'not-a-file-id')).status, 404);
  });

  test('does not serve files from a share that is still being uploaded', async () => {
    const { body: pending } = await app.api('/shares', { method: 'POST', json: { files: [{ name: 'a.txt', size: 5 }], expiry: { type: 'in', hours: 1 } } });
    await app.api(`/shares/${pending.code}/files/${pending.files[0].id}`, { method: 'PUT', token: pending.uploadToken, body: Buffer.from('hello') });
    assert.equal((await download(app, pending.code, pending.files[0].id)).status, 404);
  });

  describe('password-protected share', () => {
    test('requires an access token', async () => {
      const { share } = await createProtectedShare();
      assert.equal((await download(app, share.code, share.files[0].id)).status, 401);
      assert.equal((await download(app, share.code, share.files[0].id, 'garbage')).status, 401);
      assert.equal((await download(app, share.code, share.files[0].id, `${Date.now() + 60_000}.AAAA`)).status, 401);
    });

    test('does not accept the upload token as an access token', async () => {
      const { share } = await createProtectedShare();
      assert.equal((await download(app, share.code, share.files[0].id, share.uploadToken)).status, 401);
    });

    test('does not accept an access token from another share', async () => {
      const { share } = await createProtectedShare();
      const other = await createProtectedShare();
      assert.equal((await download(app, share.code, share.files[0].id, other.token)).status, 401);
    });

    test('returns the stored ciphertext to a holder of the access token', async () => {
      const ciphertext = randomBytes(5000);
      const { share, token } = await createProtectedShare([{ name: 'secret.pdf', content: ciphertext }]);
      const { status, headers, bytes } = await download(app, share.code, share.files[0].id, token);
      assert.equal(status, 200);
      assert.ok(bytes.equals(ciphertext));
      assert.equal(headers.get('content-disposition'), 'attachment; filename=secret.pdf.enc');
    });
  });
});

describe('share that expires after the first download', () => {
  const stillThere = async (code) => (await lookup(code)).status === 200;

  test('is deleted once its only file has been downloaded', async () => {
    const share = await createReadyShare(app, [hello], { expiry: FIRST_DOWNLOAD });
    const fileKey = `files/${share.code}/${share.files[0].id}`;
    assert.equal((await lookup(share.code)).body.burnAfterDownload, true);

    const first = await download(app, share.code, share.files[0].id);
    assert.equal(first.status, 200);
    assert.equal(first.bytes.toString(), 'hello');

    await eventually(async () => !(await stillThere(share.code)));
    assert.equal((await download(app, share.code, share.files[0].id)).status, 404);
    await eventually(async () => !(await objectExists(fileKey)) && !(await objectExists(`meta/${share.code}.json`)));
  });

  test('hands out each file once and is deleted after the last one', async () => {
    const share = await createReadyShare(app, [hello, { name: 'b.txt', content: Buffer.from('second') }], { expiry: FIRST_DOWNLOAD });
    const [a, b] = share.files;

    assert.equal((await download(app, share.code, a.id)).status, 200);
    await eventually(async () => (await lookup(share.code)).body.files.length === 1);
    assert.deepEqual((await lookup(share.code)).body.files.map((f) => f.name), ['b.txt']);
    assert.equal((await download(app, share.code, a.id)).status, 410);
    await eventually(async () => !(await objectExists(`files/${share.code}/${a.id}`)));
    assert.equal(await objectExists(`files/${share.code}/${b.id}`), true);

    assert.equal((await download(app, share.code, b.id)).bytes.toString(), 'second');
    await eventually(async () => !(await stillThere(share.code)));
    await eventually(async () => !(await objectExists(`meta/${share.code}.json`)));
  });

  test('is left alone by a lookup or a failed download', async () => {
    const share = await createReadyShare(app, [hello], { expiry: FIRST_DOWNLOAD });
    await lookup(share.code);
    await download(app, share.code, 'not-a-file-id');
    assert.equal((await download(app, share.code, share.files[0].id)).status, 200);
  });

  // The next two tests need a download that is still in progress. A file much
  // larger than the socket buffers stays in progress for as long as the
  // response is left unread.
  const BIG = 32 * 1024 * 1024;
  const openDownload = (share, fileId) => new Promise((resolve, reject) => {
    http.get(`${app.url}/api/shares/${share.code}/files/${fileId}`, resolve).on('error', reject);
  });

  test('keeps a file whose download was abandoned part-way', async () => {
    const content = randomBytes(BIG);
    const share = await createReadyShare(app, [{ name: 'big.bin', content }], { expiry: FIRST_DOWNLOAD });
    const res = await openDownload(share, share.files[0].id);
    assert.equal(res.statusCode, 200);
    res.destroy();

    const retry = await eventually(async () => {
      const attempt = await download(app, share.code, share.files[0].id);
      return attempt.status === 200 && attempt;
    });
    assert.ok(retry.bytes.equals(content));
  });

  test('refuses a second download of a file while the first is running', async () => {
    const share = await createReadyShare(app, [{ name: 'big.bin', content: Buffer.alloc(BIG) }], { expiry: FIRST_DOWNLOAD });
    const res = await openDownload(share, share.files[0].id);
    assert.equal(res.statusCode, 200);

    assert.equal((await download(app, share.code, share.files[0].id)).status, 409);

    let received = 0;
    for await (const chunk of res) received += chunk.length;
    assert.equal(received, BIG);
    await eventually(async () => !(await stillThere(share.code)));
  });
});
