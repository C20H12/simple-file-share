import { useEffect, useRef, useState } from 'react';
import { fileUrl } from './api.js';
import { downloadFile, saveBlob, saveUrl } from './download.js';
import { canPreview } from './format.js';

// Gap between downloads when starting several, so the browser accepts each one.
const STAGGER_MS = 500;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Downloads for the files of one share.
//
// A share without a password downloads straight from the server: the browser
// streams each file to disk and shows its own progress. A password-protected
// share cannot do that, because only this page holds the key, so each file is
// fetched into memory, decrypted, then handed to the browser.
//
//   states       { [fileId]: 'busy' | 'started' | 'done' }
//                  busy     being fetched and decrypted
//                  started  one-time file handed to the browser's downloader
//                  done     one-time file decrypted and saved
//   hrefFor      the direct download link for a file, or undefined if it needs decrypting
//   save         download one file that needs decrypting
//   saveAll      start every remaining download, one after another
//   markStarted  note that the user followed a one-time file's direct link
//   load         fetch a file into memory for previewing
export function useShareDownloads({ share, access, onAuthExpired }) {
  const { code, files } = share;
  const oneTime = share.burnAfterDownload;
  const direct = !access;
  const [states, setStates] = useState({});
  const [allBusy, setAllBusy] = useState(false);
  const [error, setError] = useState('');

  const abort = useRef(null);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current.abort();
  }, []);

  const setState = (file, state) => setStates(({ [file.id]: _old, ...rest }) => (state ? { ...rest, [file.id]: state } : rest));

  const report = (err, name) => {
    if (abort.current.signal.aborted) return;
    if (err.status === 401) onAuthExpired?.();
    else if (err.status === 404 || err.status === 410) setError(`${name} is no longer available. It may have expired or already been downloaded.`);
    else if (err.status === 429) setError('Too many attempts. Wait a few minutes and try again.');
    else if (err.name === 'OperationError') setError(`${name} could not be decrypted.`);
    else setError(`${name} could not be downloaded. Check your connection and try again.`);
  };

  const fetchBlob = (file) => downloadFile({ code, file, access, signal: abort.current.signal });

  // A one-time file is served once, so its row is retired after use.
  const markStarted = (file) => { if (oneTime) setState(file, 'started'); };

  const save = async (file) => {
    if (states[file.id]) return true;
    setError('');
    setState(file, 'busy');
    try {
      saveBlob(await fetchBlob(file), file.name);
      setState(file, oneTime ? 'done' : null);
      return true;
    } catch (err) {
      setState(file, null);
      report(err, file.name);
      return false;
    }
  };

  const saveAll = async () => {
    setAllBusy(true);
    for (const file of files.filter((f) => !states[f.id])) {
      if (direct) {
        saveUrl(fileUrl(code, file.id), file.name);
        markStarted(file);
        await pause(STAGGER_MS);
      } else if (!(await save(file))) {
        break; // the error is on screen; don't pile further failures on top
      }
    }
    setAllBusy(false);
  };

  const load = (file) => (canPreview(file) ? fetchBlob(file) : Promise.reject(new Error('too large to preview')));

  return {
    states,
    error,
    allBusy,
    allUsed: files.every((f) => states[f.id] === 'started' || states[f.id] === 'done'),
    hrefFor: (file) => (direct ? fileUrl(code, file.id) : undefined),
    save,
    saveAll,
    markStarted,
    load,
  };
}
