import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { canPreview, formatSize, isPdf, isText } from '../lib/format.js';
import { saveBlob } from '../lib/download.js';

const PdfPages = lazy(() => import('./PdfPages.jsx'));

const Note = ({ children }) => <div className="pv-image"><span className="pv-note truncate">{children}</span></div>;

// Shows file `index` of `files`.
//   load(file)   resolves with the file's Blob
//   hrefFor(file) the file's direct download link, or undefined if it has to be
//                 decrypted, in which case Download saves the copy already loaded here
export default function PreviewDialog({ files, index, load, hrefFor, onNavigate, onClose }) {
  const file = files[index];
  const previewable = files.map((_, i) => i).filter((i) => canPreview(files[i]));
  const pos = previewable.indexOf(index);
  const pdf = isPdf(file.name);
  const text = isText(file.name);
  const href = hrefFor(file);

  // loading | ready (with blob; url for images, content for text) | failed
  const [view, setView] = useState({ status: 'loading' });
  const [pages, setPages] = useState(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    let url;
    setView({ status: 'loading' });
    setPages(null);
    const { name } = files[index];
    loadRef.current(files[index])
      .then(async (blob) => {
        // Text is read as UTF-8 and shown as plain text, never interpreted.
        // A NUL byte means the file is binary despite its name.
        const content = isText(name) ? await blob.text() : undefined;
        if (!live) return;
        if (content?.includes('\u0000')) throw new Error('not text');
        if (!isPdf(name) && !isText(name)) url = URL.createObjectURL(blob);
        setView({ status: 'ready', blob, url, content });
      })
      .catch(() => { if (live) setView({ status: 'failed' }); });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = () => setView({ status: 'failed' });

  const lines = view.content == null ? null : view.content.split('\n').length - (view.content.endsWith('\n') ? 1 : 0);
  const meta = [
    pdf ? 'PDF' : text ? 'Text' : 'Image',
    lines != null && `${lines} ${lines === 1 ? 'line' : 'lines'}`,
    pages && `${pages} ${pages === 1 ? 'page' : 'pages'}`,
    formatSize(file.size),
    previewable.length > 1 && `${pos + 1} of ${previewable.length}`,
  ].filter(Boolean).join(' · ');

  let body;
  if (view.status === 'loading') {
    body = <Note>Loading preview…</Note>;
  } else if (view.status === 'failed') {
    body = <Note>This file can’t be previewed here. Download it to open it.</Note>;
  } else if (text) {
    body = <pre className="pv-text">{view.content}</pre>;
  } else if (pdf) {
    body = (
      <Suspense fallback={<Note>Loading preview…</Note>}>
        <PdfPages blob={view.blob} onPages={setPages} onError={fail} />
      </Suspense>
    );
  } else {
    // Some formats (HEIC) only display in certain browsers; fall back if this one can't.
    body = <div className="pv-image"><img src={view.url} alt={file.name} onError={fail} /></div>;
  }

  const download = <><span>Download</span><Icon name="download" invert /></>;

  return (
    <div className="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog dialog-preview" role="dialog" aria-modal="true" aria-label="File preview">
        <div className="dialog-head">
          <div style={{ minWidth: 0 }}>
            <div className="dialog-title truncate">{file.name}</div>
            <div className="k num">{meta}</div>
          </div>
          <button className="btn btn-secondary btn-icon" onClick={onClose} aria-label="Close preview">
            <Icon name="x" size={18} />
          </button>
        </div>

        {body}

        <div className="dialog-foot">
          {previewable.length > 1 && (
            <>
              <button className="btn btn-secondary" disabled={pos <= 0} onClick={() => onNavigate(previewable[pos - 1])}>
                <Icon name="arrow-left" />Previous file
              </button>
              <button className="btn btn-secondary" disabled={pos >= previewable.length - 1} onClick={() => onNavigate(previewable[pos + 1])}>
                Next file<Icon name="arrow-right" />
              </button>
            </>
          )}
          {href ? (
            <a className="btn btn-primary pv-dl" href={href} download={file.name}>{download}</a>
          ) : (
            <button className="btn btn-primary pv-dl" disabled={!view.blob} onClick={() => saveBlob(view.blob, file.name)}>{download}</button>
          )}
        </div>
      </div>
    </div>
  );
}
