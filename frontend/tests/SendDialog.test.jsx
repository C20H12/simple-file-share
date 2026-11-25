// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// The dialog's size check is what is under test; nothing is sent anywhere.
vi.mock('../src/lib/upload.js', async (importOriginal) => ({ ...(await importOriginal()), uploadShare: vi.fn() }));
vi.mock('../src/lib/peer.js', () => ({ hostFiles: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('') } }));

const { default: SendDialog } = await import('../src/components/SendDialog.jsx');
const { uploadShare } = await import('../src/lib/upload.js');
const { ApiError } = await import('../src/lib/api.js');

afterEach(cleanup);

// Picks files of the given sizes through the dialog's file input.
function pick(container, sizes) {
  const input = container.querySelector('input[type="file"]');
  const files = sizes.map((size, i) => ({ name: `file${i}.bin`, size, type: '' }));
  fireEvent.change(input, { target: { files } });
}

const continueButton = () => screen.getByRole('button', { name: /Continue/ });

describe('upload size limit in the send dialog', () => {
  test('within the limit, Continue is enabled and nothing is shown', () => {
    const { container } = render(<SendDialog mode="upload" onClose={vi.fn()} />);
    pick(container, [30e6, 20e6]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  test('over the limit, it says by how much in MB and disables Continue', () => {
    const { container } = render(<SendDialog mode="upload" onClose={vi.fn()} />);
    pick(container, [30e6, 25e6]);
    expect(screen.getByRole('alert').textContent).toBe(
      'These files add up to 55.0 MB. Uploads are limited to 50 MB; use Peer share to send larger files.',
    );
    expect(continueButton().disabled).toBe(true);
  });

  test('removing a file brings the selection back under the limit', () => {
    const { container } = render(<SendDialog mode="upload" onClose={vi.fn()} />);
    pick(container, [30e6, 25e6]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  test('peer share has no size limit', () => {
    const { container } = render(<SendDialog mode="peer" onClose={vi.fn()} />);
    pick(container, [4.7e9]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });
});

describe('expiry', () => {
  test('defaults to after first download, and offers fixed durations only', () => {
    render(<SendDialog mode="upload" onClose={vi.fn()} />);
    const select = screen.getByLabelText('Expires');
    expect(select.value).toBe('After first download');
    expect([...select.options].map((o) => o.value)).toEqual(['1 hour', '12 hours', '1 day', '7 days', 'After first download']);
    expect(screen.queryByLabelText('Expiry date')).toBeNull();
  });
});

describe('when the server is out of storage', () => {
  test('says so and suggests peer share', async () => {
    uploadShare.mockRejectedValueOnce(new ApiError(507, 'the server is out of storage space; try again later', { reason: 'storage-full' }));
    const { container } = render(<SendDialog mode="upload" onClose={vi.fn()} />);
    pick(container, [1000]);
    fireEvent.click(continueButton());
    expect(await screen.findByText(/out of storage space right now/)).toBeTruthy();
    expect(screen.getByText(/use Peer share, which sends files directly/)).toBeTruthy();
  });
});

describe('text only', () => {
  const toggle = (name) => screen.getByRole('button', { name });

  test('the underlined link swaps the file picker for a text box, and back, keeping picked files', () => {
    const { container } = render(<SendDialog mode="upload" onClose={vi.fn()} />);
    pick(container, [1000]);
    fireEvent.click(toggle('Upload text only'));
    expect(screen.getByLabelText('Text').tagName).toBe('TEXTAREA');
    expect(screen.queryByText('Choose files')).toBeNull();
    fireEvent.click(toggle('Choose files instead'));
    expect(screen.queryByLabelText('Text')).toBeNull();
    expect(screen.getByText('file0.bin')).toBeTruthy();
  });

  test('Continue stays disabled until some text is typed', () => {
    render(<SendDialog mode="upload" onClose={vi.fn()} />);
    fireEvent.click(toggle('Upload text only'));
    expect(continueButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'hello' } });
    expect(continueButton().disabled).toBe(false);
  });

  test('the text is uploaded as text.txt', async () => {
    uploadShare.mockReturnValueOnce(new Promise(() => {}));
    render(<SendDialog mode="upload" onClose={vi.fn()} />);
    fireEvent.click(toggle('Upload text only'));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'meeting at 3, room 2B ✓' } });
    fireEvent.click(continueButton());
    const [{ files }] = uploadShare.mock.calls.at(-1);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('text.txt');
    expect(files[0].type).toBe('text/plain');
    const content = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(files[0]);
    });
    expect(content).toBe('meeting at 3, room 2B ✓');
  });

  test('in peer share the link says send', () => {
    render(<SendDialog mode="peer" onClose={vi.fn()} />);
    expect(toggle('Send text only')).toBeTruthy();
  });
});
