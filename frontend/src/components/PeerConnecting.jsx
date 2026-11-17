import ProgressBar from './ProgressBar.jsx';

// phase: "connecting" | "listing"
export default function PeerConnecting({ phase, onCancel }) {
  const listing = phase === 'listing';
  return (
    <div className="g">
      <div className="rule" />
      <div className="lab"><h2 className="xl">Connecting</h2></div>
      <div className="con">
        <div className="m4 pending">
          <div className="k">{listing ? 'Step 2 of 2' : 'Step 1 of 2'}</div>
          <h3>{listing ? 'Getting file list' : 'Connecting to sender'}</h3>
          <ProgressBar value={listing ? 85 : 35} className="slow" />
          <p>
            {listing
              ? 'Connected. Asking the sender’s browser which files are shared.'
              : 'Setting up a direct connection. The sender must have their tab open.'}
          </p>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
