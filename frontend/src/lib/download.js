import { fetchFile } from './api.js';
import { decryptChunk, fromBase64 } from './crypto.js';
import { openFileSink } from './fileSink.js';
import { extOf } from './format.js';

const TAG_BYTES = 16;

// Blob types are chosen here from the file extension, never taken from the
// uploader, so a preview can only ever be treated as an image or a PDF.
const PREVIEW_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf',
};
export const blobType = (name) => PREVIEW_TYPES[extOf(name).toLowerCase()] ?? 'application/octet-stream';

// Reassembles the encrypted chunks from a stream that delivers them in
// arbitrary pieces, decrypts each one and passes the plaintext to `write`.
// See crypto.js for the format.
function chunkDecryptor(file, { key, chunkSize }, write) {
  const nonce = fromBase64(file.nonce);
  const count = Math.max(1, Math.ceil(file.size / chunkSize));
  const buffer = new Uint8Array(chunkSize + TAG_BYTES);
  let filled = 0;
  let index = 0;

  const flush = async () => {
    await write(await decryptChunk(key, nonce, index, index === count - 1, buffer.subarray(0, filled)));
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
    },
  };
}

// Passes the contents of a file response from the server, piece by piece and
// decrypted if the share is password-protected, to `write`. `write` may
// return a promise; reading waits for it, so a slow consumer slows the
// download instead of piling data up.
//   access  { token, key, chunkSize } for a protected share, otherwise null
async function pump(res, { file, access }, write) {
  const reader = res.body.getReader();
  const decryptor = access ? chunkDecryptor(file, access, write) : null;
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (decryptor) await decryptor.push(value);
      else await write(value);
    }
    if (received !== file.storedSize) throw new Error('file is incomplete');
    await decryptor?.finish();
  } finally {
    reader.cancel().catch(() => {}); // stops the transfer if we are leaving early
  }
}

const request = ({ code, file, access, signal }) => fetchFile(code, file.id, access?.token, signal);

async function intoBlob(res, options) {
  const parts = [];
  await pump(res, options, (bytes) => { parts.push(bytes); });
  return new Blob(parts, { type: blobType(options.file.name) });
}

// Fetches a file into memory and resolves with it as a Blob. For previews,
// which need the whole file at hand.
//   options  { code, file, access, signal }
export const downloadFile = async (options) => intoBlob(await request(options), options);

// Fetches a file and saves it, writing to disk as it arrives so that even a
// large file never sits in memory. Where the browser cannot do that, the file
// is built in memory and then handed over. Resolves once the browser has it.
//   options  { code, file, access, signal }
export async function saveFile(options) {
  const { file } = options;
  // Ask the server first: if it refuses (expired, already taken), no browser
  // download is started that would only fail.
  const res = await request(options);
  const sink = await openFileSink(file.name, file.size);
  if (!sink) {
    saveBlob(await intoBlob(res, options), file.name);
    return;
  }
  try {
    await pump(res, options, (bytes) => sink.write(bytes));
    await sink.close();
  } catch (err) {
    sink.abort();
    throw err;
  }
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
