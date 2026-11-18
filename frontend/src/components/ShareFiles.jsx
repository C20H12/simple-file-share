import Icon from './Icon.jsx';
import FileRow from './FileRow.jsx';
import { countLabel, formatSize, totalSize } from '../lib/format.js';

// The received file list. `downloads` is what useDownloads returns.
// Leave out `onPreview` to make the files download-only.
export default function ShareFiles({ files, expiryText, downloads, onPreview }) {
  const { states, percents, error, allBusy, allUsed, hrefFor, save, saveAll, markStarted } = downloads;
  return (
    <div className="g">
      <div className="rule" />
      <div className="lab stack">
        <h2 className="xl">{countLabel(files.length)}</h2>
        <div className="num">
          <div className="strong">{formatSize(totalSize(files))}</div>
          <div>{expiryText}</div>
        </div>
        <button className="btn btn-primary btn-tall" disabled={allBusy || allUsed} onClick={saveAll}>
          <span>Download all</span>
          <Icon name="download" size={24} invert />
        </button>
        {error && <p className="notice" role="alert">{error}</p>}
      </div>
      <div className="con">
        <div className="m8 file-list">
          {files.map((file, i) => (
            <FileRow
              key={file.id}
              file={file}
              href={hrefFor(file)}
              state={states[file.id]}
              percent={percents[file.id]}
              onPreview={onPreview && (() => onPreview(i))}
              onDownload={() => save(file)}
              onStarted={() => markStarted(file)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
