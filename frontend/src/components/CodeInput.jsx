import { useRef } from 'react';
import Icon from './Icon.jsx';
import { formatCode } from '../lib/format.js';

const LENGTH = 6;

// Six display boxes backed by a single invisible input, so paste, autofill
// and mobile one-time-code keyboards all work. The clear button sits outside
// the boxes, which the input covers.
export default function CodeInput({ value, onChange, onEnter }) {
  const cursor = Math.min(value.length, LENGTH - 1);
  const inputRef = useRef(null);
  const clear = () => {
    onChange('');
    inputRef.current?.focus();
  };
  return (
    <div className="code-row">
      <div className="code">
        {Array.from({ length: LENGTH }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={['code-box', i === 3 && 'gap', value[i] && 'filled', i === cursor && 'cur'].filter(Boolean).join(' ')}
          >
            {value[i] ?? ''}
          </span>
        ))}
        <input
          ref={inputRef}
          aria-label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={LENGTH + 1}
          value={formatCode(value)}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, LENGTH))}
          onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
        />
      </div>
      {/* Hidden rather than removed while empty, so the boxes keep their width. */}
      <button
        type="button"
        className="btn btn-secondary code-clear"
        aria-label="Clear code"
        title="Clear code"
        onClick={clear}
        hidden={!value}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}
