// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PreviewDialog from '../src/components/PreviewDialog.jsx';

afterEach(cleanup);

// Stands in for a fetched Blob. jsdom's Blob has no text(), which browsers do.
const textBlob = (content) => ({ text: async () => content });

function show(files, load, index = 0) {
  return render(
    <PreviewDialog files={files} index={index} load={load} hrefFor={() => undefined} onNavigate={vi.fn()} onClose={vi.fn()} />,
  );
}

describe('text preview', () => {
  test('shows the file as plain text, never as markup', async () => {
    const content = 'Wi-Fi: Handoff-Guest\n<b>not bold</b><script>alert(1)</script>\n';
    const { container } = show([{ id: 'a', name: 'text.txt', size: content.length }], vi.fn().mockResolvedValue(textBlob(content)));
    const pre = await screen.findByText(/Wi-Fi: Handoff-Guest/);
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe(content);
    expect(container.querySelector('b, script')).toBeNull();
  });

  test('says it is text and how many lines it has', async () => {
    show([{ id: 'a', name: 'notes.md', size: 12 }], vi.fn().mockResolvedValue(textBlob('one\ntwo\nthree\n')));
    expect(await screen.findByText(/^Text · 3 lines · /)).toBeTruthy();
  });

  test('a file with binary content falls back to the download note', async () => {
    show([{ id: 'a', name: 'fake.txt', size: 4 }], vi.fn().mockResolvedValue(textBlob('PK\u0003\u0004\u0000\u0000')));
    expect(await screen.findByText(/can’t be previewed here/)).toBeTruthy();
    expect(document.querySelector('pre')).toBeNull();
  });

  test('moves between text and image files that can be previewed', async () => {
    const files = [
      { id: 'a', name: 'text.txt', size: 5 },
      { id: 'b', name: 'archive.zip', size: 5 },
      { id: 'c', name: 'photo.png', size: 5 },
    ];
    show(files, vi.fn().mockResolvedValue(textBlob('hello')));
    expect(await screen.findByText(/1 of 2$/)).toBeTruthy(); // the zip is skipped
  });
});
