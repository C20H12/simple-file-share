import Icon from '../components/Icon.jsx';
import { formatCode } from '../lib/format.js';

// Receiving is not wired to the backend yet. The pieces this page will render
// once it is are in components/: PasswordGate, PeerConnecting, ShareFiles and
// PreviewDialog.
export default function ReceivePage({ code, kind, onBack }) {
  return (
    <main className="receive">
      <div className="g receive-head">
        <div className="m4">
          <button className="btn btn-secondary" onClick={onBack}><Icon name="arrow-left" />Back</button>
        </div>
        <div className="h2c"><div className="k">Code</div><div className="code-value">{formatCode(code)}</div></div>
        <div className="h2c"><div className="k">Shared as</div><div className="strong">{kind === 'peer' ? 'Peer share' : 'Uploaded'}</div></div>
      </div>
      <div className="g">
        <div className="rule" />
        <div className="lab"><h2 className="xl">Not yet</h2></div>
        <div className="con">
          <p className="m8">Receiving files is not connected to the server yet.</p>
        </div>
      </div>
    </main>
  );
}
