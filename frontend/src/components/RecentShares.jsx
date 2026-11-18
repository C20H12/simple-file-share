import Icon from './Icon.jsx';
import { formatCode } from '../lib/format.js';
import { clearRecents, useRecents } from '../lib/recents.js';
import { navigate, sharePath } from '../lib/router.js';
import { useCopied } from '../lib/useCopied.js';

const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const when = (time) => dateTime.format(new Date(time));

// Home-page section listing the shares this browser recently uploaded or
// opened. Renders nothing while the list is empty.
export default function RecentShares() {
  const recents = useRecents();
  const [copiedCode, copy] = useCopied();
  if (!recents.length) return null;

  return (
    <section className="g">
      <div className="rule" />
      <div className="lab stack">
        <h2 className="xl">Recent</h2>
        <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={clearRecents}>
          <Icon name="x" />Clear
        </button>
      </div>
      <div className="con">
        <div className="m8 file-list">
          {recents.map((entry) => {
            const uploaded = entry.kind === 'uploaded';
            const path = sharePath(entry.code);
            const link = `${window.location.origin}${path}`;
            // A plain click stays in the app; modified clicks (new tab) use the real link.
            const open = (event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(path);
            };
            return (
              <div key={entry.code} className="file-row">
                <div className="file-ext"><Icon name={uploaded ? 'upload' : 'download'} size={20} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="recent-head">
                    <span className="code-value">{formatCode(entry.code)}</span>
                    <span className="k num">
                      {uploaded ? 'Uploaded' : 'Received'} {when(entry.at)} · {entry.oneTime ? 'Expires after first download' : `Expires ${when(Date.parse(entry.expiresAt))}`}
                    </span>
                  </div>
                  <a className="file-link recent-link" href={path} onClick={open} title="Open">{link}</a>
                </div>
                <button className="btn btn-secondary" onClick={() => copy(entry.code, link)}>
                  <Icon name="copy" />{copiedCode === entry.code ? 'Copied' : 'Copy'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
