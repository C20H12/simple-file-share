// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearRecents, recordReceived, recordUploaded, removeRecent, useRecents } from '../src/lib/recents.js';

const KEY = 'handoff.recent.v1';
const future = (days = 1) => new Date(Date.now() + days * 86_400_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();
const share = (code, extra = {}) => ({ code, expiresAt: future(), burnAfterDownload: false, ...extra });
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
const current = () => renderHook(() => useRecents()).result.current;

beforeEach(() => {
  window.localStorage.clear();
});

describe('recording', () => {
  test('keeps uploaded and received shares, newest first', () => {
    recordUploaded(share('111111'));
    recordReceived(share('222222', { burnAfterDownload: true }));
    expect(current()).toMatchObject([
      { code: '222222', kind: 'received', oneTime: true },
      { code: '111111', kind: 'uploaded', oneTime: false },
    ]);
  });

  test('stores only the code, kind, times and one-time flag: nothing secret', () => {
    recordUploaded({ ...share('111111'), uploadToken: 'secret-token', accessToken: 'secret-access' });
    const [entry] = stored();
    expect(Object.keys(entry).sort()).toEqual(['at', 'code', 'expiresAt', 'kind', 'oneTime']);
    expect(window.localStorage.getItem(KEY)).not.toContain('secret');
  });

  test('a share recorded again moves to the top instead of appearing twice', () => {
    recordReceived(share('111111'));
    recordReceived(share('222222'));
    recordReceived(share('111111'));
    expect(current().map((e) => e.code)).toEqual(['111111', '222222']);
  });

  test('keeps at most 10 entries', () => {
    for (let i = 0; i < 12; i++) recordReceived(share(String(100000 + i)));
    const codes = current().map((e) => e.code);
    expect(codes).toHaveLength(10);
    expect(codes[0]).toBe('100011');
    expect(codes).not.toContain('100000');
  });

  test('opening a share this browser uploaded keeps it listed as uploaded', () => {
    const mine = share('111111');
    recordUploaded(mine);
    recordReceived(mine);
    expect(current()).toMatchObject([{ code: '111111', kind: 'uploaded' }]);
  });

  test('the same code with a different expiry is someone else’s share now', () => {
    recordUploaded(share('111111', { expiresAt: future(1) }));
    recordReceived(share('111111', { expiresAt: future(2) }));
    expect(current()).toMatchObject([{ code: '111111', kind: 'received' }]);
  });
});

describe('expiry and removal', () => {
  test('expired shares are not listed', () => {
    window.localStorage.setItem(KEY, JSON.stringify([
      { code: '111111', kind: 'uploaded', at: 1, expiresAt: past(), oneTime: false },
      { code: '222222', kind: 'uploaded', at: 2, expiresAt: future(), oneTime: false },
    ]));
    expect(current().map((e) => e.code)).toEqual(['222222']);
  });

  test('expired shares are dropped from storage on the next write', () => {
    window.localStorage.setItem(KEY, JSON.stringify([{ code: '111111', kind: 'uploaded', at: 1, expiresAt: past(), oneTime: false }]));
    recordReceived(share('222222'));
    expect(stored().map((e) => e.code)).toEqual(['222222']);
  });

  test('removeRecent drops one code', () => {
    recordReceived(share('111111'));
    recordReceived(share('222222'));
    removeRecent('111111');
    expect(current().map((e) => e.code)).toEqual(['222222']);
  });

  test('removing a code that is not listed writes nothing', () => {
    recordReceived(share('111111'));
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    removeRecent('999999');
    expect(spy).not.toHaveBeenCalled();
  });

  test('clearRecents empties the list and removes the storage key', () => {
    recordReceived(share('111111'));
    clearRecents();
    expect(current()).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('reading storage', () => {
  test('ignores corrupt data', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(current()).toEqual([]);
    window.localStorage.setItem(KEY, '{"an":"object"}');
    expect(current()).toEqual([]);
  });

  test('ignores entries that are not well-formed', () => {
    const good = { code: '111111', kind: 'received', at: 1, expiresAt: future(), oneTime: false };
    window.localStorage.setItem(KEY, JSON.stringify([
      good,
      null,
      { ...good, code: '12345' },
      { ...good, code: '<script>' },
      { ...good, kind: 'stolen' },
      { ...good, at: 'yesterday' },
      { ...good, expiresAt: 'never' },
    ]));
    expect(current()).toEqual([good]);
  });

  test('works, as an empty list, when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(current()).toEqual([]);
    expect(() => recordReceived(share('111111'))).not.toThrow();
  });
});

describe('useRecents', () => {
  test('re-renders when the list changes in this tab', () => {
    const { result } = renderHook(() => useRecents());
    expect(result.current).toEqual([]);
    act(() => recordUploaded(share('111111')));
    expect(result.current.map((e) => e.code)).toEqual(['111111']);
    act(() => clearRecents());
    expect(result.current).toEqual([]);
  });

  test('re-renders when another tab changes it', () => {
    const { result } = renderHook(() => useRecents());
    act(() => {
      // What another tab's write looks like from here: the value changes, then a storage event.
      window.localStorage.setItem(KEY, JSON.stringify([{ code: '333333', kind: 'received', at: 1, expiresAt: future(), oneTime: false }]));
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
    expect(result.current.map((e) => e.code)).toEqual(['333333']);
  });

  test('returns the same list between renders while nothing changes', () => {
    recordUploaded(share('111111'));
    const { result, rerender } = renderHook(() => useRecents());
    const first = result.current;
    rerender();
    expect(result.current).toEqual(first);
  });
});
