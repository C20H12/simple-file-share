// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCopied } from '../src/lib/useCopied.js';

let writeText;
beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  delete navigator.clipboard;
});

test('copies the text and names what was copied for a moment', () => {
  const { result } = renderHook(() => useCopied());
  expect(result.current[0]).toBe('');
  act(() => result.current[1]('link', 'https://example.test/123456'));
  expect(writeText).toHaveBeenCalledWith('https://example.test/123456');
  expect(result.current[0]).toBe('link');
  act(() => vi.advanceTimersByTime(1599));
  expect(result.current[0]).toBe('link');
  act(() => vi.advanceTimersByTime(1));
  expect(result.current[0]).toBe('');
});

test('a second copy takes over and restarts the moment', () => {
  const { result } = renderHook(() => useCopied());
  act(() => result.current[1]('link', 'a'));
  act(() => vi.advanceTimersByTime(1000));
  act(() => result.current[1]('code', 'b'));
  expect(result.current[0]).toBe('code');
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current[0]).toBe('code');
  act(() => vi.advanceTimersByTime(600));
  expect(result.current[0]).toBe('');
});

test('still confirms when the clipboard refuses or is missing', () => {
  writeText.mockRejectedValue(new Error('denied'));
  const { result } = renderHook(() => useCopied());
  act(() => result.current[1]('link', 'a'));
  expect(result.current[0]).toBe('link');
  delete navigator.clipboard;
  act(() => result.current[1]('code', 'b'));
  expect(result.current[0]).toBe('code');
});
