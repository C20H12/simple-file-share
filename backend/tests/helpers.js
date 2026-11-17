// Shared setup for the endpoint tests. Each test file runs in its own process
// against a real MinIO (start it with `npm run minio:up`), using a throwaway
// bucket so the real "shares" bucket is never touched.
//
// Import server modules through this file, never directly, so the settings
// below are in place before any of them load.
process.env.MINIO_BUCKET = `shares-test-${process.pid}`;
process.env.SWEEP_INTERVAL_MS = '200';
// Every request comes from 127.0.0.1, so the normal limits would trip on the
// tests' own 404s. rate-limit.test.js lowers them again.
process.env.LOOKUP_MAX_MISSES = '100000';
process.env.UNLOCK_MAX_FAILURES = '100000';

const { start } = await import('../src/app.js');
const { storage, bucket } = await import('../src/storage.js');
const { config } = await import('../src/config.js');

export { storage, bucket, config };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startTestServer() {
  const { server, stop } = await start({ port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;

  // api('/shares', { method, token, json, body }) -> { status, body }
  const api = async (path, { method = 'GET', token, json, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${url}/api${path}`, { method, headers, body: json ? JSON.stringify(json) : body });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const close = async () => {
    await stop();
    const keys = [];
    for await (const obj of storage.listObjectsV2(bucket, '', true)) keys.push(obj.name);
    if (keys.length) await storage.removeObjects(bucket, keys);
    await storage.removeBucket(bucket);
  };

  return { url, api, close };
}

export async function readObject(key) {
  const chunks = [];
  for await (const chunk of await storage.getObject(bucket, key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export const objectExists = (key) => storage.statObject(bucket, key).then(() => true, () => false);

export const readShareRecord = async (code) => JSON.parse((await readObject(`meta/${code}.json`)).toString());

export const IN_ONE_HOUR = { type: 'in', hours: 1 };

// Retries `check` until it returns a truthy value, for effects that land
// shortly after a response (deleting a downloaded file, sweeping).
export async function eventually(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

// A valid `encryption` block, shaped like the one the browser sends.
export const encryptionParams = (overrides = {}) => ({
  kdf: { name: 'PBKDF2', hash: 'SHA-512', iterations: 210_000, salt: Buffer.alloc(16, 1).toString('base64') },
  verifier: Buffer.alloc(32, 2).toString('base64'),
  chunkSize: 4 * 1024 * 1024,
  ...overrides,
});

// Creates a share, uploads its files and completes it.
// files: [{ name, content: Buffer }]. With `encryption`, each content stands in
// for the ciphertext of a single chunk: the plaintext plus a 16-byte tag.
export async function createReadyShare(app, files, { expiry = IN_ONE_HOUR, encryption } = {}) {
  const manifest = files.map(({ name, content, type }) => ({
    name,
    type,
    size: encryption ? content.length - 16 : content.length,
    ...(encryption && { nonce: Buffer.alloc(8, 3).toString('base64') }),
  }));
  const created = await app.api('/shares', { method: 'POST', json: { files: manifest, expiry, ...(encryption && { encryption }) } });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const share = created.body;
  for (const [i, file] of share.files.entries()) {
    const put = await app.api(`/shares/${share.code}/files/${file.id}`, { method: 'PUT', token: share.uploadToken, body: files[i].content });
    if (put.status !== 204) throw new Error(`upload failed: ${put.status} ${JSON.stringify(put.body)}`);
  }
  const done = await app.api(`/shares/${share.code}/complete`, { method: 'POST', token: share.uploadToken });
  if (done.status !== 200) throw new Error(`complete failed: ${done.status}`);
  return { ...share, expiresAt: done.body.expiresAt };
}

// Downloads a file. Resolves with { status, headers, bytes }.
export async function download(app, code, fileId, token) {
  const res = await fetch(`${app.url}/api/shares/${code}/files/${fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}
