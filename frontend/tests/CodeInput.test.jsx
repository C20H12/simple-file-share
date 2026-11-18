// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CodeInput from '../src/components/CodeInput.jsx';

afterEach(cleanup);

test('typing keeps digits only, up to six', () => {
  const onChange = vi.fn();
  render(<CodeInput value="" onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '48a2 9131' } });
  expect(onChange).toHaveBeenCalledWith('482913');
});

test('the clear button is hidden while there is nothing to clear', () => {
  const { container } = render(<CodeInput value="" onChange={vi.fn()} />);
  expect(container.querySelector('.code-clear').hidden).toBe(true);
  expect(screen.queryByRole('button', { name: 'Clear code' })).toBeNull();
});

test('the clear button empties the code and returns focus to the input', () => {
  const onChange = vi.fn();
  render(<CodeInput value="482" onChange={onChange} />);
  const clear = screen.getByRole('button', { name: 'Clear code' });
  expect(clear.hidden).toBe(false);
  fireEvent.click(clear);
  expect(onChange).toHaveBeenCalledWith('');
  expect(document.activeElement).toBe(screen.getByLabelText('6-digit code'));
});

test('Enter submits', () => {
  const onEnter = vi.fn();
  render(<CodeInput value="482913" onChange={vi.fn()} onEnter={onEnter} />);
  fireEvent.keyDown(screen.getByLabelText('6-digit code'), { key: 'Enter' });
  expect(onEnter).toHaveBeenCalledTimes(1);
});
