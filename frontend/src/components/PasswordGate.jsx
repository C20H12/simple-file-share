import { useState } from 'react';
import Icon from './Icon.jsx';

// onSubmit(password) resolves to true if the password unlocked the share.
export default function PasswordGate({ onSubmit }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const submit = async () => {
    if (!(await onSubmit(value))) setError(true);
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
            aria-label="Password"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {error && <div className="pw-error notice">Wrong password. Check with the sender and try again.</div>}
        </div>
        <div className="field m4">
          <button className="btn btn-primary btn-tall" style={{ width: '100%' }} onClick={submit}>
            <span>Unlock</span><Icon name="arrow-right" size={24} invert />
          </button>
        </div>
      </div>
    </div>
  );
}
