// Shared setup for the endpoint tests. Each test file runs in its own process
// against a real MinIO (start it with `npm run minio:up`), using a throwaway
// bucket so the real "shares" bucket is never touched.
process.env.MINIO_BUCKET = `shares-test-${process.pid}`;
process.env.SWEEP_INTERVAL_MS = '200';

const { start } = await import('../src/app.js');
const { storage, bucket } = await import('../src/storage.js');

export { storage, bucket };

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

// A valid `encryption` block, shaped like the one the browser sends.
export const encryptionParams = (overrides = {}) => ({
  kdf: { name: 'PBKDF2', hash: 'SHA-512', iterations: 210_000, salt: Buffer.alloc(16, 1).toString('base64') },
  verifier: Buffer.alloc(32, 2).toString('base64'),
  chunkSize: 4 * 1024 * 1024,
  ...overrides,
});
