import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import Icon from './Icon.jsx';
import ProgressBar from './ProgressBar.jsx';
import { formatCode, formatSize, summary } from '../lib/format.js';
import { DEFAULT_EXPIRY, EXPIRY_OPTIONS, MAX_UPLOAD_LABEL, STORAGE_FULL_MESSAGE, uploadShare, uploadTooLarge } from '../lib/upload.js';
import { hostFiles } from '../lib/peer.js';
import { sharePath } from '../lib/router.js';
import { recordUploaded } from '../lib/recents.js';
import { useCopied } from '../lib/useCopied.js';

function FilePicker({ files, onAdd, onRemove }) {
  const inputRef = useRef(null);
  return (
    <>
      <input type="file" multiple hidden ref={inputRef} onChange={(e) => { onAdd(Array.from(e.target.files)); e.target.value = ''; }} />
      <button
        className="drop"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onAdd(Array.from(e.dataTransfer.files)); }}
      >
        <Icon name="file-plus" size={24} />
        <span><span className="strong" style={{ display: 'block' }}>Choose files</span><span className="k">or drop them here</span></span>
      </button>
      {files.length > 0 && (
        <div>
          <div className="picked-summary text-muted">{summary(files)}</div>
          {files.map((f, i) => (
            <div key={i} className="picked-row">
              <span className="name truncate">{f.name}</span>
              <span className="text-muted" style={{ fontSize: 12 }}>{formatSize(f.size)}</span>
              <button className="btn btn-ghost" style={{ padding: 4 }} aria-label="Remove" onClick={() => onRemove(i)}><Icon name="x" size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CopyButton({ text, id, copied, onCopy }) {
  return (
    <button className="btn btn-secondary" style={{ flex: 'none' }} onClick={() => onCopy(id, text)}>
      <Icon name="copy" />{copied === id ? 'Copied' : 'Copy'}
    </button>
  );
}

function QrCode({ value }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { margin: 0, width: 256, color: { dark: '#171c24', light: '#0000' } })
      .then((url) => { if (live) setSrc(url); })
      .catch(() => {});
    return () => { live = false; };
  }, [value]);
  return <div className="qr" role="img" aria-label="QR code" style={src ? { backgroundImage: `url("${src}")` } : undefined} />;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// What the sender sees for each state of a peer share (see hostFiles).
const PEER_STATUS = {
  waiting: ['Waiting for receiver', () => 'Keep this dialog open. Files are sent when the receiver opens the link or enters the code.'],
  connected: ['Connected', () => 'The receiver can see the files. Each one is sent when they download it.'],
  transferring: ['Transferring', (percent) => `${percent}% sent, direct to the receiver.`],
  complete: ['Complete', () => 'All files were received. You can close this dialog.'],
  lost: ['Connection lost', (percent) => `The receiver dropped off at ${percent}%. Keep this dialog open so they can reconnect and download again.`],
};

function PeerStatus({ peer, files, onDone }) {
  const [title, detail] = PEER_STATUS[peer.status];
  return (
    <div className="peer-status">
      <div className="between" style={{ alignItems: 'baseline' }}>
        <span className="title">{title}</span>
        <span className="text-muted" style={{ fontSize: 12 }}>{summary(files)}</span>
      </div>
      <ProgressBar value={peer.percent} className={peer.status === 'lost' ? 'muted' : ''} />
      <div>{detail(peer.percent)}</div>
      {peer.status === 'complete' && <button className="btn btn-primary btn-start" onClick={onDone}>Done</button>}
    </div>
  );
}

// mode: "upload" (stored on the server) or "peer" (direct, browser to browser)
export default function SendDialog({ mode, onClose }) {
  const isUpload = mode === 'upload';
  const [step, setStep] = useState('select'); // select -> progress -> done
  const [files, setFiles] = useState([]); // File objects
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const [customDate, setCustomDate] = useState('');
  const [password, setPassword] = useState('');
  const [progress, setProgress] = useState({ phase: 'uploading', percent: 0 });
  const [error, setError] = useState('');
  const [share, setShare] = useState(null); // { code, ... } once uploaded or hosted
  const [starting, setStarting] = useState(false);
  const [peer, setPeer] = useState({ status: 'waiting', percent: 0 });
  const [copied, copy] = useCopied();
  const abortRef = useRef(null);
  const hostRef = useRef(null);
  const open = useRef(false);

  // Closing the dialog cancels an upload in flight and ends a peer share: the
  // files are only reachable while this dialog is hosting them.
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      abortRef.current?.abort();
      hostRef.current?.stop();
    };
  }, []);

  const link = share ? `${window.location.origin}${sharePath(share.code, isUpload ? 'uploaded' : 'peer')}` : '';

  const shareLink = () => {
    if (navigator.share) navigator.share({ title: 'Files via Handoff', text: `Code ${formatCode(share.code)}`, url: link }).catch(() => {});
    else copy('share', link);
  };

  const upload = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setProgress({ phase: 'uploading', percent: 0 });
    setStep('progress');
    try {
      const result = await uploadShare({ files, expiry, customDate, password, onProgress: setProgress, signal: controller.signal });
      recordUploaded(result);
      setShare(result);
      setStep('done');
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err.status === 507) setError(STORAGE_FULL_MESSAGE);
      // The dialog checks the size first; this covers a server set to a lower limit.
      else if (err.status === 413) setError(`These files are too large to upload. Uploads are limited to ${err.data?.maxBytes ? formatSize(err.data.maxBytes) : MAX_UPLOAD_LABEL}.`);
      else setError(err.message || 'Upload failed.');
    }
  };

  // Nothing is read or sent yet: the page keeps the picked File objects and
  // reads from them only when a receiver asks for a file.
  const startPeerShare = async () => {
    setError('');
    setStarting(true);
    try {
      const host = await hostFiles(files, (state) => { if (open.current) setPeer(state); });
      if (!open.current) { host.stop(); return; }
      hostRef.current = host;
      setShare({ code: host.code });
      setStep('done');
    } catch {
      if (open.current) setError('Peer share could not start. Check your connection and try again.');
    }
    if (open.current) setStarting(false);
  };

  const needsDate = expiry === 'Custom date' && !customDate;
  const tooLarge = isUpload ? uploadTooLarge(files) : null;
  const canContinue = files.length > 0 && (isUpload ? !needsDate && !tooLarge : !starting);
  const expiryLabel = expiry === 'Custom date' ? customDate : expiry.toLowerCase();

  return (
    <div className="dialog-backdrop">
      <div className="dialog dialog-send" role="dialog" aria-modal="true" aria-label={isUpload ? 'Upload files' : 'Peer share'}>
        <div className="dialog-head">
          <div className="dialog-title">{isUpload ? 'Upload files' : 'Peer share'}</div>
          <button className="btn btn-secondary btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>

        {step === 'select' && (
          <>
            <FilePicker
              files={files}
              onAdd={(add) => setFiles((fs) => fs.concat(add))}
              onRemove={(i) => setFiles((fs) => fs.filter((_, j) => j !== i))}
            />
            {tooLarge && <p className="notice" role="alert">{tooLarge}</p>}
            {isUpload ? (
              <div className="options">
                <div className="field">
                  <label htmlFor="send-expiry">Expires</label>
                  <select id="send-expiry" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                    {EXPIRY_OPTIONS.map((o) => <option key={o}>{o}</option>)}
                  </select>
                </div>
                {expiry === 'Custom date' && (
                  <div className="field">
                    <label htmlFor="send-date">Expiry date</label>
                    <input id="send-date" className="input" type="date" min={today()} value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="send-password">Password (optional)</label>
                  <input id="send-password" className="input" type="text" placeholder="None" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
              </div>
            ) : (
              <>
                <p className="text-muted">Files stay on your device and are sent directly once the receiver connects.</p>
                {error && <p className="notice" role="alert">{error}</p>}
              </>
            )}
            <button className="btn btn-primary btn-row" disabled={!canContinue} onClick={isUpload ? upload : startPeerShare}>
              <span>Continue</span><Icon name="arrow-right" size={18} invert />
            </button>
          </>
        )}

        {step === 'progress' && (
          <>
            <div className="between strong">
              <span>{progress.phase === 'encrypting' ? 'Encrypting' : 'Uploading'} {summary(files)}</span>
              <span className="num">{progress.percent}%</span>
            </div>
            <ProgressBar value={progress.percent} />
            {error && (
              <>
                <p className="notice">{error}</p>
                <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setStep('select')}>
                  <Icon name="arrow-left" />Back
                </button>
              </>
            )}
          </>
        )}

        {step === 'done' && (
          <>
            <div className="done">
              {isUpload && <QrCode value={link} />}
              <div className="done-fields">
                <div className="field">
                  <label htmlFor="send-link">Link</label>
                  <div className="copy-row">
                    <input id="send-link" className="input" readOnly value={link} />
                    <CopyButton id="link" text={link} copied={copied} onCopy={copy} />
                  </div>
                </div>
                <div className="field">
                  <label>Code</label>
                  <div className="share-code">
                    <span>{formatCode(share.code)}</span>
                    <CopyButton id="code" text={share.code} copied={copied} onCopy={copy} />
                  </div>
                </div>
              </div>
            </div>
            {isUpload ? (
              <>
                <div className="done-meta">Expires: {expiryLabel} · {share.passwordProtected ? 'Password protected' : 'No password'}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-row" style={{ flex: 1 }} onClick={shareLink}>
                    <span>{copied === 'share' ? 'Link copied' : 'Share…'}</span><Icon name="share-2" size={18} invert />
                  </button>
                  <button className="btn btn-secondary" style={{ padding: '12px 16px' }} onClick={onClose}>Done</button>
                </div>
              </>
            ) : (
              <PeerStatus peer={peer} files={files} onDone={onClose} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
