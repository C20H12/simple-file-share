import Icon from './Icon.jsx';
import ProgressBar from './ProgressBar.jsx';
import { canPreview, extOf, formatSize } from '../lib/format.js';

// One received file. `progress` is undefined when idle, else 0..100.
export default function FileRow({ file, progress, onPreview, onDownload }) {
  const active = progress != null;
  const done = active && progress >= 100;
  return (
    <div className="file-row">
      <div className="file-ext">{extOf(file.name).slice(0, 4)}</div>
      <div style={{ minWidth: 0 }}>
        {canPreview(file.name) ? (
          <button className="file-link" onClick={onPreview} title="Preview">{file.name}</button>
        ) : (
          <div className="strong truncate">{file.name}</div>
        )}
        <div className="k num">
          {active ? `${formatSize((file.size * progress) / 100)} of ${formatSize(file.size)}` : formatSize(file.size)}
        </div>
        {active && <ProgressBar value={progress} />}
      </div>
      <button className="btn btn-secondary file-dl keep-opacity" disabled={active} onClick={onDownload}>
        <Icon name={done ? 'check' : 'download'} />
        {active ? (done ? 'Complete' : `${progress}%`) : 'Download'}
      </button>
    </div>
  );
}
