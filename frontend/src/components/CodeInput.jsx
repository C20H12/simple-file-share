import { formatCode } from '../lib/format.js';

const LENGTH = 6;

// Six display boxes backed by a single invisible input, so paste, autofill
// and mobile one-time-code keyboards all work.
export default function CodeInput({ value, onChange, onEnter }) {
  const cursor = Math.min(value.length, LENGTH - 1);
  return (
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
        aria-label="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={LENGTH + 1}
        value={formatCode(value)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, LENGTH))}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
      />
    </div>
  );
}
