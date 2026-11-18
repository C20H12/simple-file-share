// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { matchRoute, navigate, sharePath, usePath } from '../src/lib/router.js';

afterEach(() => window.history.replaceState(null, '', '/'));

describe('matchRoute', () => {
  test('/ is the home page', () => {
    expect(matchRoute('/')).toEqual({ name: 'home' });
  });

  test('a 6-digit code is an uploaded share', () => {
    expect(matchRoute('/482913')).toEqual({ name: 'receive', kind: 'uploaded', code: '482913' });
    expect(matchRoute('/482913/')).toEqual({ name: 'receive', kind: 'uploaded', code: '482913' });
  });

  test('/p/ and a code is a peer share', () => {
    expect(matchRoute('/p/715046')).toEqual({ name: 'receive', kind: 'peer', code: '715046' });
  });

  test('anything else is unknown', () => {
    for (const path of ['/12345', '/1234567', '/abcdef', '/p/', '/p/12345', '/x/123456', '/123456/extra', '']) {
      expect(matchRoute(path), path).toEqual({ name: 'unknown' });
    }
  });
});

describe('sharePath', () => {
  test('builds the link path for each kind of share', () => {
    expect(sharePath('482913')).toBe('/482913');
    expect(sharePath('482913', 'uploaded')).toBe('/482913');
    expect(sharePath('715046', 'peer')).toBe('/p/715046');
  });

  test('round-trips through matchRoute', () => {
    expect(matchRoute(sharePath('715046', 'peer'))).toMatchObject({ kind: 'peer', code: '715046' });
  });
});

describe('navigate', () => {
  test('pushes a history entry and tells listeners', () => {
    const onChange = vi.fn();
    window.addEventListener('popstate', onChange);
    const before = window.history.length;
    navigate('/482913');
    window.removeEventListener('popstate', onChange);
    expect(window.location.pathname).toBe('/482913');
    expect(window.history.length).toBe(before + 1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('replace swaps the current entry instead', () => {
    const before = window.history.length;
    navigate('/482913', { replace: true });
    expect(window.location.pathname).toBe('/482913');
    expect(window.history.length).toBe(before);
  });

  test('going to the current path does nothing', () => {
    const onChange = vi.fn();
    window.addEventListener('popstate', onChange);
    const before = window.history.length;
    navigate('/');
    window.removeEventListener('popstate', onChange);
    expect(window.history.length).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('usePath', () => {
  test('follows navigation', () => {
    const { result } = renderHook(() => usePath());
    expect(result.current).toBe('/');
    act(() => navigate('/p/715046'));
    expect(result.current).toBe('/p/715046');
  });
});
