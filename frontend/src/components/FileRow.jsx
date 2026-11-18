import Icon from './Icon.jsx';
import { canPreview, extOf, formatSize } from '../lib/format.js';

const USED = { started: 'Started', done: 'Downloaded' };

// One received file.
//   href       direct download link; without it the Download button calls onDownload
//   state      'busy' while the file is being fetched into memory, or 'started' /
//              'done' once a one-time file has been used
//   percent    progress of a busy file, when its source reports any
//   onStarted  called after the user follows the direct link
//   onPreview  leave out to show the name as plain text
export default function FileRow({ file, href, state, percent, onPreview, onDownload, onStarted }) {
  let action;
  if (state === 'busy') {
    action = <button className="btn btn-secondary file-dl keep-opacity num" disabled><Icon name="download" />{percent == null ? 'Downloading' : `${percent}%`}</button>;
  } else if (state) {
    action = <button className="btn btn-secondary file-dl" disabled><Icon name="check" />{USED[state]}</button>;
  } else if (href) {
    // A real link, so the browser streams the file to disk itself. The row is
    // only updated after the click has gone through.
    action = <a className="btn btn-secondary file-dl" href={href} download={file.name} onClick={() => setTimeout(onStarted, 0)}><Icon name="download" />Download</a>;
  } else {
    action = <button className="btn btn-secondary file-dl" onClick={onDownload}><Icon name="download" />Download</button>;
  }

  return (
    <div className="file-row">
      <div className="file-ext">{extOf(file.name).slice(0, 4)}</div>
      <div style={{ minWidth: 0 }}>
        {onPreview && canPreview(file) ? (
          <button className="file-link" onClick={onPreview} title="Preview">{file.name}</button>
        ) : (
          <div className="strong truncate">{file.name}</div>
        )}
        <div className="k num">{formatSize(file.size)}</div>
      </div>
      {action}
    </div>
  );
}
