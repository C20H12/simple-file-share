const BASE = import.meta.env?.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', token, json, body, signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: json ? JSON.stringify(json) : body, signal });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data;
}

// manifest: { files: [{ name, size, type, nonce? }], expiry, encryption? }
export const createShare = (manifest, signal) => request('/shares', { method: 'POST', json: manifest, signal });

export const uploadFile = (code, fileId, blob, token, signal) =>
  request(`/shares/${code}/files/${fileId}`, { method: 'PUT', body: blob, token, signal });

export const getUploadProgress = (code, token, signal) => request(`/shares/${code}/progress`, { token, signal });

export const completeShare = (code, token, signal) => request(`/shares/${code}/complete`, { method: 'POST', token, signal });
