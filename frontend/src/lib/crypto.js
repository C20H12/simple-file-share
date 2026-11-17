// Client-side encryption for password-protected shares.
//
// Key derivation: PBKDF2-SHA-512(password, salt) -> 64 bytes.
//   bytes 0-31   AES-256-GCM key. Never leaves the browser.
//   bytes 32-63  verifier. Sent to the server, which stores only a hash of it
//                and uses it to check the password without learning the key.
//
// File format: the file is split into CHUNK_SIZE pieces, each encrypted
// separately and concatenated as ciphertext + 16-byte tag.
//   IV for chunk i  = the file's 8-byte nonce + i as a 4-byte big-endian counter
//   AAD for chunk i = one byte, 1 for the final chunk and 0 otherwise, so a
//                     truncated file fails to decrypt
// An empty file is stored as a single empty chunk.

export const CHUNK_SIZE = 4 * 1024 * 1024;
const TAG_BYTES = 16;
const KDF = { name: 'PBKDF2', hash: 'SHA-512', iterations: 210_000 };

export const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));

export const encryptedSize = (size) => size + TAG_BYTES * chunkCount(size);

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// Returns { key, verifier, kdf } for a new share; `kdf` goes to the server so
// receivers can repeat the derivation.
export async function deriveShareKeys(password, salt = randomBytes(16), iterations = KDF.iterations) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ ...KDF, salt, iterations }, material, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return {
    key,
    verifier: toBase64(bits.slice(32)),
    kdf: { name: KDF.name, hash: KDF.hash, iterations, salt: toBase64(salt) },
  };
}

function chunkParams(nonce, index, isLast) {
  const iv = new Uint8Array(12);
  iv.set(nonce);
  new DataView(iv.buffer).setUint32(8, index);
  return { name: 'AES-GCM', iv, additionalData: new Uint8Array([isLast ? 1 : 0]) };
}

// Encrypts a File/Blob and returns the ciphertext as a Blob.
// onProgress receives the number of plaintext bytes encrypted so far.
export async function encryptFile(file, key, nonce, { onProgress, signal } = {}) {
  const count = chunkCount(file.size);
  const parts = [];
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    const start = i * CHUNK_SIZE;
    const plain = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();
    parts.push(await crypto.subtle.encrypt(chunkParams(nonce, i, i === count - 1), key, plain));
    onProgress?.(Math.min(file.size, start + CHUNK_SIZE));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
