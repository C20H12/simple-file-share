import Icon from './Icon.jsx';
import { canPreview, formatSize, isPdf } from '../lib/format.js';

// Page count is estimated from file size until real previews are served.
const pageCount = (file) => Math.max(1, Math.round(file.size / 6e5));

function PdfPages({ count }) {
  return (
    <div className="pv-pages" tabIndex={0} role="group" aria-label="Document pages">
      {Array.from({ length: count }, (_, k) => (
        <div
          key={k}
          className="pv-page"
          style={{ backgroundSize: `${88 + ((k * 5) % 12)}% ${k % 3 === 2 ? 52 : 76}%` }}
        >
          <span className="head" style={{ width: `${k ? 34 + ((k * 13) % 30) : 62}%`, height: k ? 9 : 16 }} />
          <span className="num">{k + 1}</span>
        </div>
      ))}
    </div>
  );
}

export default function PreviewDialog({ files, index, progress, onNavigate, onDownload, onClose }) {
  const file = files[index];
  const previewable = files.map((_, i) => i).filter((i) => canPreview(files[i].name));
  const pos = previewable.indexOf(index);
  const pdf = isPdf(file.name);
  const pages = pdf ? pageCount(file) : 1;
  const active = progress != null;

  const meta = [
    pdf ? `PDF · ${pages} ${pages === 1 ? 'page' : 'pages'}` : 'Image',
    formatSize(file.size),
    previewable.length > 1 && `${pos + 1} of ${previewable.length}`,
  ].filter(Boolean).join(' · ');

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

        {pdf ? (
          <PdfPages count={pages} />
        ) : (
          <div className="pv-image"><span className="truncate">image preview · {file.name}</span></div>
        )}

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
          <button className="btn btn-primary pv-dl keep-opacity" disabled={active} onClick={onDownload}>
            <span>{!active ? 'Download' : progress >= 100 ? 'Complete' : `Downloading ${progress}%`}</span>
            <Icon name="download" invert />
          </button>
        </div>
      </div>
    </div>
  );
}
