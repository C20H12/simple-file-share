import { useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import PasswordGate from '../components/PasswordGate.jsx';
import PeerConnecting from '../components/PeerConnecting.jsx';
import PreviewDialog from '../components/PreviewDialog.jsx';
import ShareFiles from '../components/ShareFiles.jsx';
import { fileUrl, getShare, unlockShare } from '../lib/api.js';
import { deriveShareKeys, fromBase64 } from '../lib/crypto.js';
import { downloadFile, saveFile } from '../lib/download.js';
import { formatCode, formatCountdown } from '../lib/format.js';
import { connectToHost, discardPartials } from '../lib/peer.js';
import { recordReceived, removeRecent } from '../lib/recents.js';
import { useDownloads } from '../lib/useDownloads.js';

const waitText = (err) => {
  const minutes = Math.ceil((err.data?.retryAfter ?? 60) / 60);
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

// A one-line state of the page. `action` is an optional { label, onClick } button.
function Message({ title, action, children }) {
  return (
    <div className="g">
      <div className="rule" />
      <div className="lab"><h2 className="xl">{title}</h2></div>
      <div className="con">
        <p className="m8">{children}</p>
        {action && (
          <div className="m8">
            <button className="btn btn-secondary" onClick={action.onClick}>{action.label}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// The file list with its downloads and previews, for either kind of share.
function Files({ files, expiryText, downloads, previews = true }) {
  const [preview, setPreview] = useState(null);
  return (
    <>
      <ShareFiles files={files} expiryText={expiryText} downloads={downloads} onPreview={previews ? setPreview : undefined} />
      {preview != null && (
        <PreviewDialog
          files={files}
          index={preview}
          load={downloads.load}
          hrefFor={downloads.hrefFor}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

// ---- Uploaded shares: files stored on the server ---------------------------

function UploadedFiles({ share, access, onAuthExpired, onExpired }) {
  const [now, setNow] = useState(Date.now);
  const { code } = share;
  // Each file of such a share can be fetched only once, so opening a preview
  // would use the file up; these shares are download-only.
  const oneTime = share.burnAfterDownload;

  const downloads = useDownloads({
    files: share.files,
    oneTime,
    // Without a password the browser downloads straight from the server. With
    // one, only this page holds the key, so files are fetched and decrypted
    // here, and written to disk as they are decrypted.
    hrefFor: access ? undefined : (file) => fileUrl(code, file.id),
    saveFile: (file, { signal }) => saveFile({ code, file, access, signal }),
    fetchBlob: (file, { signal }) => downloadFile({ code, file, access, signal }),
    describeError: (err, name) => {
      if (err.status === 401) { onAuthExpired(); return null; }
      if (err.status === 404 || err.status === 410) return `${name} is no longer available. It may have expired or already been downloaded.`;
      if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
      if (err.name === 'OperationError') return `${name} could not be decrypted.`;
      return `${name} could not be downloaded. Check your connection and try again.`;
    },
  });

  const remaining = Date.parse(share.expiresAt) - now;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (remaining <= 0) onExpired();
  }, [remaining <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Files
      files={share.files}
      expiryText={oneTime ? 'Expires after first download' : `Expires in ${formatCountdown(remaining)}`}
      downloads={downloads}
      previews={!oneTime}
    />
  );
}

// Looks the code up, asks for the password if there is one, then lists the files.
function UploadedShare({ code }) {
  const [status, setStatus] = useState('loading'); // loading | locked | ready | missing | limited | failed
  const [share, setShare] = useState(null);
  const [access, setAccess] = useState(null); // { token, key, chunkSize } once unlocked
  const [wait, setWait] = useState('');

  // The code no longer leads anywhere, so it leaves the home page's recent list too.
  const gone = () => {
    removeRecent(code);
    setStatus('missing');
  };

  const fail = (err) => {
    if (err.status === 404) gone();
    else if (err.status === 429) { setWait(waitText(err)); setStatus('limited'); }
    else setStatus('failed');
  };

  useEffect(() => {
    const controller = new AbortController();
    getShare(code, controller.signal)
      .then((found) => {
        recordReceived(found);
        setShare(found);
        setStatus(found.files ? 'ready' : 'locked');
      })
      .catch((err) => { if (!controller.signal.aborted) fail(err); });
    return () => controller.abort();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlock = async (password) => {
    const { kdf, chunkSize } = share.encryption;
    try {
      const { key, verifier } = await deriveShareKeys(password, fromBase64(kdf.salt), kdf.iterations);
      const { accessToken, files } = await unlockShare(code, verifier);
      setAccess({ token: accessToken, key, chunkSize });
      setShare({ ...share, files });
      setStatus('ready');
      return null;
    } catch (err) {
      if (err.status === 401) return 'Wrong password. Check with the sender and try again.';
      if (err.status === 429) return `Too many wrong passwords. ${waitText(err)}`;
      if (err.status === 404) { gone(); return null; }
      return 'The password could not be checked. Check your connection and try again.';
    }
  };

  // The access token lasts an hour; after that, ask for the password again.
  const relock = () => {
    setAccess(null);
    setShare((s) => ({ ...s, files: null }));
    setStatus('locked');
  };

  switch (status) {
    case 'locked':
      return <PasswordGate onSubmit={unlock} />;
    case 'ready':
      return <UploadedFiles share={share} access={access} onAuthExpired={relock} onExpired={gone} />;
    case 'missing':
      return <Message title="Not found">Nothing is shared under this code. It may have expired, or the code may be mistyped.</Message>;
    case 'limited':
      return <Message title="Try later">Too many codes were tried from your network. {wait}</Message>;
    case 'failed':
      return <Message title="Error">The server could not be reached. Check your connection and reload the page.</Message>;
    default:
      return null;
  }
}

// ---- Peer shares: files sent live from the sender's browser ----------------

function PeerFiles({ host }) {
  const downloads = useDownloads({
    files: host.files,
    saveFile: (file, options) => host.save(file, options),
    describeError: (err, name) => {
      if (err.kind === 'lost') return null; // the page switches to its "Lost" state
      if (err.kind === 'refused') return `${name} could not be sent. ${err.message}`;
      return `${name} could not be downloaded. Try again.`;
    },
  });
  return (
    <Files
      files={host.files}
      expiryText="Live from the sender’s browser. Downloads stop if they close their tab."
      downloads={downloads}
      previews={false}
    />
  );
}

// Connects to the sender's browser, fetches the file list, then lists the files.
function PeerShare({ code, onCancel }) {
  const [phase, setPhase] = useState('connecting'); // connecting | listing | ready | missing | lost | failed
  const [host, setHost] = useState(null);
  const [attempt, setAttempt] = useState(0);
  // Interrupted downloads, kept across reconnects so they resume. Each may hold
  // a browser download open, so they are given up when this page is left.
  const partials = useRef(new Map());
  useEffect(() => () => discardPartials(partials.current), []);

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    let connected = null;
    setPhase('connecting');
    setHost(null);
    connectToHost(code, {
      signal: controller.signal,
      partials: partials.current,
      onPhase: (next) => { if (live()) setPhase(next); },
      onLost: () => { if (live()) setPhase('lost'); },
    })
      .then((found) => {
        if (!live()) { found.close(); return; }
        connected = found;
        setHost(found);
        setPhase('ready');
      })
      .catch((err) => {
        if (!live()) return;
        // With the sender gone for good there is nothing left to resume from.
        if (err.kind === 'unavailable') discardPartials(partials.current);
        setPhase(err.kind === 'unavailable' ? 'missing' : 'failed');
      });
    return () => {
      controller.abort();
      connected?.close();
    };
  }, [code, attempt]);

  const retry = { label: 'Reconnect', onClick: () => setAttempt((n) => n + 1) };

  switch (phase) {
    case 'ready':
      return <PeerFiles host={host} />;
    case 'missing':
      return <Message title="Not found">Nobody is sharing under this code right now. The sender has to keep their page open, and the code may be mistyped.</Message>;
    case 'lost':
      return <Message title="Lost" action={retry}>The connection to the sender was lost. They may have closed their page. Downloads that were interrupted resume when you reconnect.</Message>;
    case 'failed':
      return <Message title="Error" action={retry}>The sender could not be reached. Check your connection and try again.</Message>;
    default:
      return <PeerConnecting phase={phase} onCancel={onCancel} />;
  }
}

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
      {kind === 'peer' ? <PeerShare code={code} onCancel={onBack} /> : <UploadedShare code={code} />}
    </main>
  );
}
