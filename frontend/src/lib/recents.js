import { useSyncExternalStore } from 'react';

// Shares this browser has recently uploaded or opened, kept in localStorage so
// the home page can list them. An entry is
//   { code, kind: 'uploaded' | 'received', at, expiresAt, oneTime }
// and nothing secret is stored: no passwords, keys or upload tokens.
const KEY = 'handoff.recent.v1';
const MAX_ENTRIES = 10;

const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

const isEntry = (e) => e != null
  && /^\d{6}$/.test(e.code)
  && (e.kind === 'uploaded' || e.kind === 'received')
  && Number.isFinite(e.at)
  && Number.isFinite(Date.parse(e.expiresAt));

function parse(raw) {
  try {
    const list = JSON.parse(raw ?? '[]');
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch {
    return [];
  }
}

// The parsed list is cached against the stored text, so repeated reads return
// the same array until the stored value actually changes.
let cache = { raw: undefined, list: [] };
function read() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch { /* storage is unavailable (private mode, blocked): behave as empty */ }
  if (raw !== cache.raw) cache = { raw, list: parse(raw) };
  return cache.list;
}

function write(list) {
  try {
    if (list.length) window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
    else window.localStorage.removeItem(KEY);
  } catch { /* full or unavailable: the list is simply not kept */ }
  notify();
}

// Expired shares are gone from the server, so they drop off the list too.
const unexpired = (list) => list.filter((e) => Date.parse(e.expiresAt) > Date.now());

const put = (entry) => write([entry, ...unexpired(read()).filter((e) => e.code !== entry.code)]);

const describe = (share, kind) => ({
  code: share.code,
  kind,
  at: Date.now(),
  expiresAt: share.expiresAt,
  oneTime: !!share.burnAfterDownload,
});

// `share` is what the server returns: { code, expiresAt, burnAfterDownload }.
export function recordUploaded(share) {
  put(describe(share, 'uploaded'));
}

export function recordReceived(share) {
  const known = read().find((e) => e.code === share.code);
  // The same code with the same expiry is the same share. Opening one this
  // browser uploaded leaves it listed as uploaded. A different expiry means the
  // code now belongs to someone else's share.
  if (known?.kind === 'uploaded' && known.expiresAt === share.expiresAt) return;
  put(describe(share, 'received'));
}

// For a code the server no longer knows.
export function removeRecent(code) {
  const list = read();
  if (list.some((e) => e.code === code)) write(list.filter((e) => e.code !== code));
}

export function clearRecents() {
  write([]);
}

function subscribe(listener) {
  listeners.add(listener);
  // Another tab changing the list arrives as a storage event.
  const onStorage = (event) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

// The current list, newest first, re-rendering when it changes in any tab.
export const useRecents = () => unexpired(useSyncExternalStore(subscribe, read));
