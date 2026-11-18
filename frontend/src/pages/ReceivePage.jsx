import { useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import PasswordGate from '../components/PasswordGate.jsx';
import PreviewDialog from '../components/PreviewDialog.jsx';
import ShareFiles from '../components/ShareFiles.jsx';
import { getShare, unlockShare } from '../lib/api.js';
import { deriveShareKeys, fromBase64 } from '../lib/crypto.js';
import { formatCode, formatCountdown } from '../lib/format.js';
import { recordReceived, removeRecent } from '../lib/recents.js';
import { useShareDownloads } from '../lib/useShareDownloads.js';

const waitText = (err) => {
  const minutes = Math.ceil((err.data?.retryAfter ?? 60) / 60);
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};

function Message({ title, children }) {
  return (
    <div className="g">
      <div className="rule" />
      <div className="lab"><h2 className="xl">{title}</h2></div>
      <div className="con"><p className="m8">{children}</p></div>
    </div>
  );
}

// The unlocked file list, with downloads and previews.
function SharedFiles({ share, access, onAuthExpired, onExpired }) {
  const [preview, setPreview] = useState(null);
  const [now, setNow] = useState(Date.now);
  const downloads = useShareDownloads({ share, access, onAuthExpired });

  const remaining = Date.parse(share.expiresAt) - now;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    if (remaining <= 0) onExpired();
  }, [remaining <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each file of such a share can be fetched only once, so opening a preview
  // would use the file up; these shares are download-only.
  const oneTime = share.burnAfterDownload;

  return (
    <>
      <ShareFiles
        files={share.files}
        expiryText={oneTime ? 'Expires after first download' : `Expires in ${formatCountdown(remaining)}`}
        downloads={downloads}
        onPreview={oneTime ? undefined : setPreview}
      />
      {preview != null && (
        <PreviewDialog
          files={share.files}
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
      return <SharedFiles share={share} access={access} onAuthExpired={relock} onExpired={gone} />;
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
      {kind === 'peer' ? (
        <Message title="Not yet">Receiving a peer share is not connected yet.</Message>
      ) : (
        <UploadedShare code={code} />
      )}
    </main>
  );
}
