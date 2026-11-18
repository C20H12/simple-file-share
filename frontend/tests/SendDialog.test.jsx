// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// The dialog's size check is what is under test; nothing is sent anywhere.
vi.mock('../src/lib/upload.js', async (importOriginal) => ({ ...(await importOriginal()), uploadShare: vi.fn() }));
vi.mock('../src/lib/peer.js', () => ({ hostFiles: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('') } }));

const { default: SendDialog } = await import('../src/components/SendDialog.jsx');

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
