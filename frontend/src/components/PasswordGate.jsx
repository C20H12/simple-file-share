import { useState } from 'react';
import Icon from './Icon.jsx';

// onSubmit(password) resolves to null if the share unlocked, otherwise to the
// message to show.
export default function PasswordGate({ onSubmit }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !value) return;
    setBusy(true);
    const message = await onSubmit(value);
    // On success the parent replaces this component, so only failure lands here.
    if (message) {
      setError(message);
      setBusy(false);
    }
  };

  return (
    <div className="g">
      <div className="rule" />
      <div className="lab stack">
        <h2 className="xl">Password</h2>
        <p>The sender protected these files. Enter the password to see them.</p>
      </div>
      <div className="con">
        <div className="field m4">
          <input
            className={`input pw-input${error ? ' error' : ''}`}
            type="password"
            autoFocus
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {error && <div className="pw-error notice" role="alert">{error}</div>}
        </div>
        <div className="field m4">
          <button className="btn btn-primary btn-tall" style={{ width: '100%' }} disabled={busy} onClick={submit}>
            <span>Unlock</span><Icon name="arrow-right" size={24} invert />
          </button>
        </div>
      </div>
    </div>
  );
}
