// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDownloads } from '../src/lib/useDownloads.js';

vi.mock('../src/lib/download.js', () => ({ saveUrl: vi.fn() }));
const { saveUrl } = await import('../src/lib/download.js');

const files = [
  { id: 'a', name: 'a.png', size: 1000 },
  { id: 'b', name: 'b.pdf', size: 2000 },
  { id: 'c', name: 'c.bin', size: 0 },
];

// A saveFile whose calls stay open until the test settles them.
function controlledSave() {
  const pending = new Map();
  const fn = vi.fn((file, options) => new Promise((resolve, reject) => pending.set(file.id, { resolve, reject, options })));
  return { fn, pending };
}

const render = (options) => renderHook((props) => useDownloads(props), { initialProps: { files, ...options } });

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe('save', () => {
  test('marks the file busy while saving, then clears it', async () => {
    const save = controlledSave();
    const { result } = render({ saveFile: save.fn });
    let done;
    act(() => { done = result.current.save(files[0]); });
    expect(result.current.states).toEqual({ a: 'busy' });
    await act(async () => { save.pending.get('a').resolve(); await done; });
    expect(result.current.states).toEqual({});
    await expect(done).resolves.toBe(true);
  });

  test('shows progress as a percentage, capped at 99 until done', async () => {
    const save = controlledSave();
    const { result } = render({ saveFile: save.fn });
    act(() => { result.current.save(files[1]); });
    const { onProgress } = save.pending.get('b').options;
    act(() => onProgress(500));
    expect(result.current.percents).toEqual({ b: 25 });
    act(() => onProgress(2000));
    expect(result.current.percents).toEqual({ b: 99 });
    await act(async () => save.pending.get('b').resolve());
    expect(result.current.percents).toEqual({});
  });

  test('a file already being saved is not saved twice', async () => {
    const save = controlledSave();
    const { result } = render({ saveFile: save.fn });
    act(() => { result.current.save(files[0]); });
    let second;
    act(() => { second = result.current.save(files[0]); });
    await expect(second).resolves.toBe(true);
    expect(save.fn).toHaveBeenCalledTimes(1);
  });

  test('a failure shows the default message', async () => {
    const { result } = render({ saveFile: vi.fn().mockRejectedValue(new Error('boom')) });
    let ok;
    await act(async () => { ok = await result.current.save(files[0]); });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('a.png could not be downloaded. Check your connection and try again.');
    expect(result.current.states).toEqual({});
  });

  test('describeError chooses the message, or hides it with null', async () => {
    const describeError = vi.fn((err, name) => (err.kind === 'lost' ? null : `${name}: ${err.message}`));
    const saveFile = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { kind: 'refused' }))
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { kind: 'lost' }));
    const { result } = render({ saveFile, describeError });
    await act(async () => { await result.current.save(files[0]); });
    expect(result.current.error).toBe('a.png: refused');
    await act(async () => { await result.current.save(files[1]); });
    expect(result.current.error).toBe(''); // cleared when the next save began, and nothing new shown
  });

  test('the user cancelling the download is not an error', async () => {
    const saveFile = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    const { result } = render({ saveFile });
    await act(async () => { await result.current.save(files[0]); });
    expect(result.current.error).toBe('');
  });

  test('leaving the page aborts saves in progress', async () => {
    const save = controlledSave();
    const { result, unmount } = render({ saveFile: save.fn });
    act(() => { result.current.save(files[0]); });
    const { signal } = save.pending.get('a').options;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe('one-time shares', () => {
  test('a saved file stays marked done, so it is not offered again', async () => {
    const { result } = render({ saveFile: vi.fn().mockResolvedValue(), oneTime: true });
    await act(async () => { await result.current.save(files[0]); });
    expect(result.current.states).toEqual({ a: 'done' });
  });

  test('following a direct link marks the file started', () => {
    const { result } = render({ saveFile: vi.fn(), oneTime: true });
    act(() => result.current.markStarted(files[0]));
    expect(result.current.states).toEqual({ a: 'started' });
  });

  test('markStarted does nothing for a normal share', () => {
    const { result } = render({ saveFile: vi.fn() });
    act(() => result.current.markStarted(files[0]));
    expect(result.current.states).toEqual({});
  });

  test('allUsed once every file is started or done', async () => {
    const { result } = render({ saveFile: vi.fn().mockResolvedValue(), oneTime: true });
    expect(result.current.allUsed).toBe(false);
    act(() => { result.current.markStarted(files[0]); result.current.markStarted(files[1]); });
    expect(result.current.allUsed).toBe(false);
    await act(async () => { await result.current.save(files[2]); });
    expect(result.current.allUsed).toBe(true);
  });
});

describe('saveAll', () => {
  test('saves through the page one file after another', async () => {
    const order = [];
    const saveFile = vi.fn(async (file) => { order.push(`start ${file.id}`); await Promise.resolve(); order.push(`end ${file.id}`); });
    const { result } = render({ saveFile });
    await act(async () => { await result.current.saveAll(); });
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(result.current.allBusy).toBe(false);
  });

  test('uses direct links where there are any, spaced out so the browser accepts each', async () => {
    vi.useFakeTimers();
    const hrefFor = (file) => `/api/shares/123456/files/${file.id}`;
    const saveFile = vi.fn();
    const { result } = render({ saveFile, hrefFor });
    let done;
    act(() => { done = result.current.saveAll(); });
    expect(result.current.allBusy).toBe(true);
    expect(saveUrl).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(saveUrl).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await done; });
    expect(saveUrl.mock.calls).toEqual(files.map((f) => [hrefFor(f), f.name]));
    expect(saveFile).not.toHaveBeenCalled();
    expect(result.current.allBusy).toBe(false);
  });

  test('stops at the first failure instead of piling up errors', async () => {
    const saveFile = vi.fn().mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom')).mockResolvedValue();
    const { result } = render({ saveFile });
    await act(async () => { await result.current.saveAll(); });
    expect(saveFile.mock.calls.map(([f]) => f.id)).toEqual(['a', 'b']);
    expect(result.current.error).toMatch(/^b\.pdf could not be downloaded/);
  });

  test('skips one-time files already used', async () => {
    const saveFile = vi.fn().mockResolvedValue();
    const { result } = render({ saveFile, oneTime: true });
    act(() => result.current.markStarted(files[0]));
    await act(async () => { await result.current.saveAll(); });
    expect(saveFile.mock.calls.map(([f]) => f.id)).toEqual(['b', 'c']);
  });
});

describe('load (previews)', () => {
  test('fetches a previewable file into memory', async () => {
    const blob = new Blob(['img']);
    const fetchBlob = vi.fn().mockResolvedValue(blob);
    const { result } = render({ saveFile: vi.fn(), fetchBlob });
    await expect(result.current.load(files[0])).resolves.toBe(blob);
    expect(fetchBlob.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('refuses files that cannot be previewed without fetching them', async () => {
    const fetchBlob = vi.fn();
    const { result } = render({ saveFile: vi.fn(), fetchBlob });
    await expect(result.current.load(files[2])).rejects.toThrow('too large to preview');
    await expect(result.current.load({ id: 'big', name: 'big.png', size: 26 * 1024 * 1024 })).rejects.toThrow();
    expect(fetchBlob).not.toHaveBeenCalled();
  });
});

test('hrefFor gives each file’s direct link, or nothing when there are none', () => {
  const { result } = render({ saveFile: vi.fn(), hrefFor: (file) => `/x/${file.id}` });
  expect(result.current.hrefFor(files[0])).toBe('/x/a');
  const plain = render({ saveFile: vi.fn() });
  expect(plain.result.current.hrefFor(files[0])).toBeUndefined();
});
