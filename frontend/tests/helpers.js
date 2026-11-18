import { vi } from 'vitest';

// Deterministic, non-repeating-looking bytes of any length.
export function pattern(size, seed = 1) {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

// Byte-for-byte comparison that stays fast for large buffers, where a deep
// equality check (and its diff on failure) would crawl.
export const sameBytes = (a, b) => Buffer.from(a.buffer ?? a, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer ?? b, b.byteOffset, b.byteLength));

export const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

// Cuts bytes into pieces of `size` (the last may be shorter).
export function split(bytes, size) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += size) parts.push(bytes.subarray(at, at + size));
  return parts;
}

// A Response whose body arrives in pieces of the given sizes, repeating the
// list until the bytes run out, the way a network delivers it.
export function streamedResponse(bytes, sizes = [7, 4096, 65_537]) {
  let at = 0;
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const n = sizes[i++ % sizes.length];
      controller.enqueue(bytes.slice(at, at + n));
      at += n;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
}

export const jsonResponse = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

// Replaces fetch with a mock; `handler(url, init)` returns a Response.
export function mockFetch(handler) {
  const fetch = vi.fn(async (url, init = {}) => handler(String(url), init));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

// A sink like openFileSink's that keeps what is written, to check against.
// With `transfer`, a written ArrayBuffer is taken over and left empty, the way
// the real sink hands it to the service worker.
export function memorySink({ transfer = false } = {}) {
  const chunks = [];
  return {
    chunks,
    closed: false,
    aborted: false,
    write: vi.fn(async function write(bytes) {
      const taken = transfer && bytes instanceof ArrayBuffer ? structuredClone(bytes, { transfer: [bytes] }) : bytes;
      chunks.push(Buffer.from(new Uint8Array(taken)));
    }),
    close: vi.fn(async function close() { this.closed = true; }),
    abort: vi.fn(function abort() { this.aborted = true; }),
    bytes: () => Buffer.concat(chunks),
  };
}

// Waits until `check` returns something truthy.
export async function until(check, { timeout = 5000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
