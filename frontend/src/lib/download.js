import { fetchFile } from './api.js';
import { decryptChunk, fromBase64 } from './crypto.js';
import { extOf } from './format.js';

const TAG_BYTES = 16;

// Blob types are chosen here from the file extension, never taken from the
// uploader, so a preview can only ever be treated as an image or a PDF.
const PREVIEW_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf',
};
const blobType = (name) => PREVIEW_TYPES[extOf(name).toLowerCase()] ?? 'application/octet-stream';

// Reassembles the encrypted chunks from a stream that delivers them in
// arbitrary pieces, and decrypts each one. See crypto.js for the format.
function chunkDecryptor(file, { key, chunkSize }) {
  const nonce = fromBase64(file.nonce);
  const count = Math.max(1, Math.ceil(file.size / chunkSize));
  const buffer = new Uint8Array(chunkSize + TAG_BYTES);
  const plain = [];
  let filled = 0;
  let index = 0;

  const flush = async () => {
    plain.push(await decryptChunk(key, nonce, index, index === count - 1, buffer.subarray(0, filled)));
    index += 1;
    filled = 0;
  };

  return {
    async push(bytes) {
      for (let offset = 0; offset < bytes.length;) {
        const n = Math.min(buffer.length - filled, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === buffer.length) await flush();
      }
    },
    async finish() {
      if (filled > 0) await flush();
      if (index !== count) throw new Error('file is incomplete');
      return plain;
    },
  };
}

// Fetches one file of a share into memory and resolves with its contents as a
// Blob, decrypted if the share is password-protected. Used for previews, and
// for downloads from protected shares, which have to be decrypted here.
//   access  { token, key, chunkSize } for a protected share, otherwise null
export async function downloadFile({ code, file, access, signal }) {
  const res = await fetchFile(code, file.id, access?.token, signal);
  const reader = res.body.getReader();
  const decryptor = access ? chunkDecryptor(file, access) : null;
  const parts = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (decryptor) await decryptor.push(value);
    else parts.push(value);
  }
  if (received !== file.storedSize) throw new Error('file is incomplete');

  return new Blob(decryptor ? await decryptor.finish() : parts, { type: blobType(file.name) });
}

// Starts a browser download from a URL. The file streams from the server
// straight to disk and is never held in page memory.
export function saveUrl(url, name) {
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
}

// Hands a Blob that is already in memory to the browser as a download.
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  saveUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
