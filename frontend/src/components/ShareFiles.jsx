import Icon from './Icon.jsx';
import FileRow from './FileRow.jsx';
import { countLabel, formatSize, totalSize } from '../lib/format.js';

// The received file list. `progress` maps a file index, or "zip" for the
// download-all archive, to 0..100 while that download is running.
export default function ShareFiles({ files, expiryText, progress = {}, onDownload, onDownloadAll, onPreview }) {
  const zip = progress.zip;
  return (
    <div className="g">
      <div className="rule" />
      <div className="lab stack">
        <h2 className="xl">{countLabel(files.length)}</h2>
        <div className="num">
          <div className="strong">{formatSize(totalSize(files))}</div>
          <div>{expiryText}</div>
        </div>
        <button className="btn btn-primary zip-btn keep-opacity" disabled={zip != null} onClick={onDownloadAll}>
          <span>{zip == null ? 'Download all (.zip)' : zip >= 100 ? 'Zip complete' : `Downloading ${zip}%`}</span>
          <Icon name="download" size={24} invert />
          <span className="zip-bar" style={{ width: `${zip ?? 0}%` }} />
        </button>
      </div>
      <div className="con">
        <div className="m8 file-list">
          {files.map((file, i) => (
            <FileRow key={i} file={file} progress={progress[i]} onPreview={() => onPreview(i)} onDownload={() => onDownload(i)} />
          ))}
        </div>
      </div>
    </div>
  );
}
