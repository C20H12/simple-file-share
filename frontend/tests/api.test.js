import { describe, expect, test } from 'vitest';
import {
  ApiError, completeShare, createShare, fetchFile, fileUrl, getShare, getUploadProgress, unlockShare, uploadFile,
} from '../src/lib/api.js';
import { jsonResponse, mockFetch } from './helpers.js';

describe('requests', () => {
  test('createShare posts the manifest as JSON', async () => {
    const fetch = mockFetch(() => jsonResponse(201, { code: '123456' }));
    const manifest = { files: [{ name: 'a.txt', size: 1, type: 'text/plain' }], expiry: { type: 'in', hours: 1 } };
    await expect(createShare(manifest)).resolves.toEqual({ code: '123456' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/shares');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual(manifest);
  });

  test('uploadFile puts the blob as the body with the upload token', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { received: 3 }));
    const blob = new Blob(['abc']);
    await uploadFile('123456', 'f1', blob, 'tok', undefined);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/shares/123456/files/f1');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(blob);
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  test('getUploadProgress and completeShare send the upload token', async () => {
    const fetch = mockFetch(() => jsonResponse(200, {}));
    await getUploadProgress('123456', 'tok');
    await completeShare('123456', 'tok');
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method, init.headers.Authorization])).toEqual([
      ['/api/shares/123456/progress', 'GET', 'Bearer tok'],
      ['/api/shares/123456/complete', 'POST', 'Bearer tok'],
    ]);
  });

  test('getShare sends no credentials', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { code: '123456', files: null }));
    await expect(getShare('123456')).resolves.toEqual({ code: '123456', files: null });
    expect(fetch.mock.calls[0][1].headers).toEqual({});
  });

  test('unlockShare posts the verifier, never the password', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { accessToken: 't' }));
    await unlockShare('123456', 'dmVyaWZpZXI=');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ verifier: 'dmVyaWZpZXI=' });
  });

  test('passes the abort signal through', async () => {
    const fetch = mockFetch(() => jsonResponse(200, {}));
    const { signal } = new AbortController();
    await getShare('123456', signal);
    expect(fetch.mock.calls[0][1].signal).toBe(signal);
  });

  test('a 204 resolves with null', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(completeShare('123456', 'tok')).resolves.toBeNull();
  });
});

describe('errors', () => {
  test('a failed request rejects with ApiError carrying the status, message and body', async () => {
    mockFetch(() => jsonResponse(429, { error: 'too many attempts', retryAfter: 60 }));
    const err = await getShare('123456').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.message).toBe('too many attempts');
    expect(err.data).toEqual({ error: 'too many attempts', retryAfter: 60 });
  });

  test('a failure without a JSON body still gets a message', async () => {
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await getShare('123456').catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Request failed (502)');
    expect(err.data).toBeNull();
  });

  test('a network failure is passed on as is', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await expect(getShare('123456')).rejects.toThrow(TypeError);
  });
});

describe('files', () => {
  test('fileUrl is the server download address', () => {
    expect(fileUrl('123456', 'f1')).toBe('/api/shares/123456/files/f1');
  });

  test('fetchFile resolves with the raw response so the body can stream', async () => {
    const response = new Response('ciphertext');
    const fetch = mockFetch(() => response);
    await expect(fetchFile('123456', 'f1', 'access')).resolves.toBe(response);
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer access' });
  });

  test('fetchFile without a token sends no Authorization header', async () => {
    const fetch = mockFetch(() => new Response('plain'));
    await fetchFile('123456', 'f1');
    expect(fetch.mock.calls[0][1].headers).toEqual({});
  });

  test('fetchFile rejects with ApiError when the server refuses', async () => {
    mockFetch(() => jsonResponse(410, { error: 'already downloaded' }));
    await expect(fetchFile('123456', 'f1')).rejects.toMatchObject({ status: 410, message: 'already downloaded' });
  });
});
