import { useEffect, useRef, useState } from 'react';
import { saveUrl } from './download.js';
import { canPreview } from './format.js';

// Gap between downloads when starting several, so the browser accepts each one.
const STAGGER_MS = 500;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Download state for a list of received files, whatever they come from.
//
// A file is saved in one of two ways:
//   by link     `hrefFor(file)` gives an address the browser can download from
//               directly (a share without a password)
//   by the page `saveFile(file, { signal, onProgress })` produces the file here
//               and saves it, resolving when done (a password-protected share,
//               which has to be decrypted here, or a peer share, which arrives
//               over a data channel)
// Previews need the file in memory: `fetchBlob(file, { signal })` resolves
// with it as a Blob.
//
// Options
//   files          [{ id, name, size }]
//   saveFile       as above; onProgress(bytes) is optional
//   fetchBlob      as above; leave out if the files are not previewed
//   hrefFor        as above; leave out if no file has a direct link
//   oneTime        each file can be fetched only once, so used rows are retired
//   describeError  (err, fileName) => the message to show, or null to show none
//
// Returns
//   states       { [fileId]: 'busy' | 'started' | 'done' }
//                  busy     being produced and saved by the page
//                  started  one-time file handed to the browser's downloader
//                  done     one-time file saved
//   percents     { [fileId]: 0..99 } for busy files whose source reports progress
//   save         save one file through the page
//   saveAll      start every remaining download, one after another
//   markStarted  note that the user followed a one-time file's direct link
//   load         fetch a file into memory for previewing
export function useDownloads({ files, saveFile, fetchBlob, hrefFor, oneTime = false, describeError }) {
  const [states, setStates] = useState({});
  const [percents, setPercents] = useState({});
  const [allBusy, setAllBusy] = useState(false);
  const [error, setError] = useState('');

  const abort = useRef(null);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current.abort();
  }, []);

  const without = (id) => ({ [id]: _gone, ...rest }) => rest;
  const setState = (file, state) => setStates((s) => (state ? { ...s, [file.id]: state } : without(file.id)(s)));

  const progressFor = (file) => {
    let shown = -1;
    return (bytes) => {
      const percent = Math.min(99, file.size ? Math.floor((bytes / file.size) * 100) : 0);
      if (percent === shown) return;
      shown = percent;
      setPercents((p) => ({ ...p, [file.id]: percent }));
    };
  };

  // A one-time file is served once, so its row is retired after use.
  const markStarted = (file) => { if (oneTime) setState(file, 'started'); };

  const save = async (file) => {
    if (states[file.id]) return true;
    setError('');
    setState(file, 'busy');
    try {
      await saveFile(file, { signal: abort.current.signal, onProgress: progressFor(file) });
      setState(file, oneTime ? 'done' : null);
      return true;
    } catch (err) {
      setState(file, null);
      // An AbortError is the user cancelling the download in the browser, or
      // leaving the page: nothing to report.
      if (!abort.current.signal.aborted && err.name !== 'AbortError') {
        const message = describeError
          ? describeError(err, file.name)
          : `${file.name} could not be downloaded. Check your connection and try again.`;
        if (message) setError(message);
      }
      return false;
    } finally {
      setPercents(without(file.id));
    }
  };

  const saveAll = async () => {
    setAllBusy(true);
    for (const file of files.filter((f) => !states[f.id])) {
      const href = hrefFor?.(file);
      if (href) {
        saveUrl(href, file.name);
        markStarted(file);
        await pause(STAGGER_MS);
      } else if (!(await save(file))) {
        break; // the error is on screen; don't pile further failures on top
      }
    }
    setAllBusy(false);
  };

  const load = (file) => (canPreview(file)
    ? fetchBlob(file, { signal: abort.current.signal })
    : Promise.reject(new Error('too large to preview')));

  return {
    states,
    percents,
    error,
    allBusy,
    allUsed: files.every((f) => states[f.id] === 'started' || states[f.id] === 'done'),
    hrefFor: (file) => hrefFor?.(file),
    save,
    saveAll,
    markStarted,
    load,
  };
}
