import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CHUNK_SIZE, deriveShareKeys, encryptFile, randomBytes, toBase64 } from '../src/lib/crypto.js';
import { blobType, downloadFile, saveBlob, saveFile, saveUrl } from '../src/lib/download.js';
import { ApiError } from '../src/lib/api.js';
import { bytesOf, jsonResponse, memorySink, mockFetch, pattern, sameBytes, streamedResponse } from './helpers.js';

// The service-worker sink needs a real browser; tests hand out an in-memory one.
vi.mock('../src/lib/fileSink.js', () => ({ openFileSink: vi.fn() }));
const { openFileSink } = await import('../src/lib/fileSink.js');

// A stand-in for the bits of the DOM saveUrl touches, recording each download it starts.
function fakeDocument() {
  const started = [];
  vi.stubGlobal('document', {
    body: { append: vi.fn() },
    createElement: vi.fn(() => ({
      click() { started.push({ href: this.href, download: this.download }); },
      remove: vi.fn(),
    })),
  });
  return started;
}

const plainFile = (bytes, name = 'data.bin') => ({ id: 'f1', name, size: bytes.length, storedSize: bytes.length });

// A protected file as the server stores it: ciphertext, plus what a receiver needs to decrypt it.
async function protectedFile(plain, name = 'secret.bin') {
  const { key } = await deriveShareKeys('pw', new Uint8Array(16), 1000);
  const nonce = randomBytes(8);
  const cipher = await bytesOf(await encryptFile(new Blob([plain]), key, nonce));
  return {
    cipher,
    file: { id: 'f1', name, size: plain.length, storedSize: cipher.length, nonce: toBase64(nonce) },
    access: { token: 'access-token', key, chunkSize: CHUNK_SIZE },
  };
}

beforeEach(() => {
  openFileSink.mockResolvedValue(null);
});

describe('blobType', () => {
  test('is chosen from the extension, for previewable types only', () => {
    expect(blobType('a.PNG')).toBe('image/png');
    expect(blobType('a.jpg')).toBe('image/jpeg');
    expect(blobType('a.pdf')).toBe('application/pdf');
  });

  test('is a plain byte stream for anything else, so nothing renders as a page', () => {
    for (const name of ['a.html', 'a.svg', 'a.js', 'noext']) expect(blobType(name), name).toBe('application/octet-stream');
  });
});

describe('downloadFile (into memory, for previews)', () => {
  test('returns the file as a Blob typed by its name', async () => {
    const bytes = pattern(100_000);
    mockFetch(() => streamedResponse(bytes));
    const blob = await downloadFile({ code: '123456', file: plainFile(bytes, 'photo.png'), access: null });
    expect(blob.type).toBe('image/png');
    expect(sameBytes(await bytesOf(blob), bytes)).toBe(true);
  });

  test('decrypts a protected file that arrives in uneven pieces across chunk boundaries', async () => {
    const plain = pattern(2 * CHUNK_SIZE + 999);
    const { cipher, file, access } = await protectedFile(plain, 'doc.pdf');
    const fetch = mockFetch(() => streamedResponse(cipher, [1, 13, 1 << 20, 3_000_017]));
    const blob = await downloadFile({ code: '123456', file, access });
    expect(fetch.mock.calls[0][0]).toBe('/api/shares/123456/files/f1');
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer access-token' });
    expect(blob.type).toBe('application/pdf');
    expect(sameBytes(await bytesOf(blob), plain)).toBe(true);
  });

  test('decrypts an empty protected file', async () => {
    const { cipher, file, access } = await protectedFile(new Uint8Array(0));
    mockFetch(() => streamedResponse(cipher));
    expect((await downloadFile({ code: '123456', file, access })).size).toBe(0);
  });

  test('rejects a response shorter than the stored size', async () => {
    const bytes = pattern(1000);
    mockFetch(() => streamedResponse(bytes.subarray(0, 900)));
    await expect(downloadFile({ code: '123456', file: plainFile(bytes), access: null })).rejects.toThrow('file is incomplete');
  });

  test('rejects a protected file missing its final chunk even if the sizes were made to match', async () => {
    const { cipher, file, access } = await protectedFile(pattern(CHUNK_SIZE + 10));
    const firstChunk = cipher.subarray(0, CHUNK_SIZE + 16);
    mockFetch(() => streamedResponse(firstChunk));
    await expect(downloadFile({ code: '123456', file: { ...file, storedSize: firstChunk.length }, access })).rejects.toThrow('file is incomplete');
  });

  test('rejects altered ciphertext', async () => {
    const { cipher, file, access } = await protectedFile(pattern(5000));
    cipher[100] ^= 0xff;
    mockFetch(() => streamedResponse(cipher));
    await expect(downloadFile({ code: '123456', file, access })).rejects.toThrow();
  });

  test('rejects with the server error when it refuses', async () => {
    mockFetch(() => jsonResponse(404, { error: 'not found' }));
    await expect(downloadFile({ code: '123456', file: plainFile(pattern(10)), access: null })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('saveFile (to disk)', () => {
  test('streams a protected file to disk as it is decrypted, then closes the download', async () => {
    const plain = pattern(CHUNK_SIZE + 12_345);
    const { cipher, file, access } = await protectedFile(plain, 'report.pdf');
    mockFetch(() => streamedResponse(cipher));
    const sink = memorySink();
    openFileSink.mockResolvedValue(sink);

    await saveFile({ code: '123456', file, access });
    expect(openFileSink).toHaveBeenCalledWith('report.pdf', plain.length);
    expect(sink.chunks.map((c) => c.length)).toEqual([CHUNK_SIZE, 12_345]); // one write per decrypted chunk
    expect(sameBytes(sink.bytes(), plain)).toBe(true);
    expect(sink.closed).toBe(true);
    expect(sink.aborted).toBe(false);
  });

  test('waits for each write before reading on, so a slow disk slows the download', async () => {
    const bytes = pattern(50_000);
    mockFetch(() => streamedResponse(bytes, [10_000]));
    const sink = memorySink();
    let writing = 0;
    let overlapped = false;
    sink.write.mockImplementation(async (chunk) => {
      overlapped ||= writing > 0;
      writing += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      sink.chunks.push(Buffer.from(chunk));
      writing -= 1;
    });
    openFileSink.mockResolvedValue(sink);
    await saveFile({ code: '123456', file: plainFile(bytes), access: null });
    expect(overlapped).toBe(false);
    expect(sameBytes(sink.bytes(), bytes)).toBe(true);
  });

  test('asks the server before starting a download, so a refused file starts none', async () => {
    mockFetch(() => jsonResponse(410, { error: 'already downloaded' }));
    await expect(saveFile({ code: '123456', file: plainFile(pattern(10)), access: null })).rejects.toMatchObject({ status: 410 });
    expect(openFileSink).not.toHaveBeenCalled();
  });

  test('abandons the download when the file turns out incomplete', async () => {
    const bytes = pattern(1000);
    mockFetch(() => streamedResponse(bytes.subarray(0, 500)));
    const sink = memorySink();
    openFileSink.mockResolvedValue(sink);
    await expect(saveFile({ code: '123456', file: plainFile(bytes), access: null })).rejects.toThrow('file is incomplete');
    expect(sink.aborted).toBe(true);
    expect(sink.closed).toBe(false);
  });

  test('stops reading when the user cancels the browser download', async () => {
    const bytes = pattern(100_000);
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(bytes.slice(0, 1000));
      },
    }, { highWaterMark: 0 });
    mockFetch(() => new Response(body));
    const sink = memorySink();
    sink.write.mockRejectedValueOnce(new DOMException('The user aborted a request.', 'AbortError'));
    openFileSink.mockResolvedValue(sink);
    await expect(saveFile({ code: '123456', file: plainFile(bytes), access: null })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.aborted).toBe(true);
    expect(pulled).toBeLessThan(5);
  });

  test('without a disk sink, builds the file in memory and hands it to the browser', async () => {
    const started = fakeDocument();
    const created = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { created.push(blob); return 'blob:test/1'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const plain = pattern(70_000);
    const { cipher, file, access } = await protectedFile(plain, 'notes.txt');
    mockFetch(() => streamedResponse(cipher));

    await saveFile({ code: '123456', file, access });
    expect(started).toEqual([{ href: 'blob:test/1', download: 'notes.txt' }]);
    expect(sameBytes(await bytesOf(created[0]), plain)).toBe(true);
  });
});

describe('saveUrl / saveBlob', () => {
  test('saveUrl starts a browser download from the address, under the file name', () => {
    const started = fakeDocument();
    saveUrl('/api/shares/123456/files/f1', 'report.pdf');
    expect(started).toEqual([{ href: '/api/shares/123456/files/f1', download: 'report.pdf' }]);
    expect(document.body.append).toHaveBeenCalledTimes(1);
  });

  test('saveBlob frees the object URL after a while', () => {
    vi.useFakeTimers();
    try {
      fakeDocument();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/2');
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      saveBlob(new Blob(['x']), 'x.txt');
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(revoke).toHaveBeenCalledWith('blob:test/2');
    } finally {
      vi.useRealTimers();
    }
  });
});
