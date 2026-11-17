const BASE = import.meta.env?.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data; // the JSON error body, e.g. { retryAfter } on a 429
  }
}

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

async function fail(res) {
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
}

async function request(path, { method = 'GET', token, json, body, signal } = {}) {
  const headers = bearer(token);
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: json ? JSON.stringify(json) : body, signal });
  if (!res.ok) throw await fail(res);
  return res.status === 204 ? null : res.json();
}

// manifest: { files: [{ name, size, type, nonce? }], expiry, encryption? }
export const createShare = (manifest, signal) => request('/shares', { method: 'POST', json: manifest, signal });

export const uploadFile = (code, fileId, blob, token, signal) =>
  request(`/shares/${code}/files/${fileId}`, { method: 'PUT', body: blob, token, signal });

export const getUploadProgress = (code, token, signal) => request(`/shares/${code}/progress`, { token, signal });

export const completeShare = (code, token, signal) => request(`/shares/${code}/complete`, { method: 'POST', token, signal });

// Receiving. `files` is null for a password-protected share until it is unlocked.
export const getShare = (code, signal) => request(`/shares/${code}`, { signal });

// Resolves with { accessToken, accessExpiresAt, files }; rejects with status 401 on a wrong password.
export const unlockShare = (code, verifier, signal) =>
  request(`/shares/${code}/unlock`, { method: 'POST', json: { verifier }, signal });

// The address a file downloads from. For a share without a password the
// browser can save straight from it; for a protected one it returns ciphertext
// and needs the access token, so those go through fetchFile instead.
export const fileUrl = (code, fileId) => `${BASE}/api/shares/${code}/files/${fileId}`;

// Resolves with the raw Response so the caller can stream the body.
export async function fetchFile(code, fileId, accessToken, signal) {
  const res = await fetch(fileUrl(code, fileId), { headers: bearer(accessToken), signal });
  if (!res.ok) throw await fail(res);
  return res;
}
