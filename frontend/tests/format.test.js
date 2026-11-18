import { describe, expect, test } from 'vitest';
import {
  PREVIEW_MAX_BYTES, canPreview, countLabel, extOf, formatCode, formatCountdown, formatSize, isImage, isPdf, summary, totalSize,
} from '../src/lib/format.js';

describe('formatSize', () => {
  test('shows an empty file as 0 KB', () => {
    expect(formatSize(0)).toBe('0 KB');
  });

  test('rounds anything under a kilobyte up to 1 KB', () => {
    expect(formatSize(1)).toBe('1 KB');
    expect(formatSize(499)).toBe('1 KB');
  });

  test('shows whole kilobytes below a megabyte', () => {
    expect(formatSize(1500)).toBe('2 KB');
    expect(formatSize(999_499)).toBe('999 KB');
  });

  test('shows megabytes with one decimal from 1 MB', () => {
    expect(formatSize(1e6)).toBe('1.0 MB');
    expect(formatSize(26_214_400)).toBe('26.2 MB');
    expect(formatSize(2.5e9)).toBe('2500.0 MB');
  });
});

describe('file summaries', () => {
  const files = [{ size: 1e6 }, { size: 5e5 }];

  test('totalSize adds the sizes up', () => {
    expect(totalSize(files)).toBe(1.5e6);
    expect(totalSize([])).toBe(0);
  });

  test('countLabel uses the singular for one file', () => {
    expect(countLabel(1)).toBe('1 file');
    expect(countLabel(0)).toBe('0 files');
    expect(countLabel(3)).toBe('3 files');
  });

  test('summary combines count and total size', () => {
    expect(summary(files)).toBe('2 files · 1.5 MB');
  });
});

describe('file types', () => {
  test('extOf takes the text after the last dot', () => {
    expect(extOf('report.final.PDF')).toBe('PDF');
    expect(extOf('archive.tar.gz')).toBe('gz');
  });

  test('extOf of a name without a dot is the whole name', () => {
    expect(extOf('README')).toBe('README');
    expect(extOf('trailing.')).toBe('');
  });

  test('isImage recognises the previewable image types, in any case', () => {
    for (const name of ['a.jpg', 'a.JPEG', 'a.png', 'a.gif', 'a.webp', 'a.heic']) expect(isImage(name), name).toBe(true);
    for (const name of ['a.svg', 'a.bmp', 'a.pdf', 'jpg.txt']) expect(isImage(name), name).toBe(false);
  });

  test('isPdf recognises .pdf only', () => {
    expect(isPdf('doc.pdf')).toBe(true);
    expect(isPdf('doc.PDF')).toBe(true);
    expect(isPdf('doc.pdf.exe')).toBe(false);
  });
});

describe('canPreview', () => {
  test('allows images and PDFs up to the size limit', () => {
    expect(canPreview({ name: 'a.png', size: PREVIEW_MAX_BYTES })).toBe(true);
    expect(canPreview({ name: 'a.pdf', size: 0 })).toBe(true);
  });

  test('refuses anything over the limit', () => {
    expect(canPreview({ name: 'a.png', size: PREVIEW_MAX_BYTES + 1 })).toBe(false);
  });

  test('refuses other file types whatever their size', () => {
    expect(canPreview({ name: 'notes.txt', size: 10 })).toBe(false);
  });
});

describe('formatCode', () => {
  test('splits a 6-digit code into two groups', () => {
    expect(formatCode('482913')).toBe('482 913');
  });

  test('leaves short input alone', () => {
    expect(formatCode('48')).toBe('48');
    expect(formatCode('482')).toBe('482');
  });
});

describe('formatCountdown', () => {
  test('shows days and zero-padded hours, minutes and seconds', () => {
    const ms = ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000;
    expect(formatCountdown(ms)).toBe('2d 03:04:05');
  });

  test('drops partial seconds', () => {
    expect(formatCountdown(1999)).toBe('0d 00:00:01');
  });

  test('never goes below zero', () => {
    expect(formatCountdown(-5000)).toBe('0d 00:00:00');
  });
});
