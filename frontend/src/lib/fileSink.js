// Writes a file to disk while its bytes are still being produced, so a
// download made in the page (decrypted, or received from a peer) never has to
// be held in memory. The work is done by the service worker in
// public/stream/sw.js; see the top of that file for how.

const WORKER_URL = `${import.meta.env.BASE_URL}stream/sw.js`;
// How far the page may run ahead of what the browser has taken. This is the
// most that is ever buffered for one download.
const WINDOW_BYTES = 8 * 1024 * 1024;
const PING_MS = 10_000;
const SETUP_TIMEOUT_MS = 15_000;
const SILENCE_TIMEOUT_MS = 35_000;

let workerReady = null;

// Resolves with the worker's registration, or null if this browser cannot run
// one here (Firefox private windows, or a page not served securely).
function getWorker() {
  workerReady ??= (async () => {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const registration = await navigator.serviceWorker.register(WORKER_URL);
      if (!registration.active) {
        await new Promise((resolve, reject) => {
          const worker = registration.installing ?? registration.waiting;
          if (!worker) return reject(new Error('no worker'));
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolve();
            else if (worker.state === 'redundant') reject(new Error('worker discarded'));
          });
        });
      }
      return registration;
    } catch {
      return null;
    }
  })();
  return workerReady;
}

const cancelled = () => new DOMException('The download was cancelled.', 'AbortError');

// Starts a browser download of `size` bytes named `name`, to be filled in by
// the caller. Resolves with null if streaming to disk is not available, in
// which case the caller should fall back to building the file in memory.
//
// The returned sink has
//   write(bytes)  queue the next piece (ArrayBuffer or Uint8Array; it is handed
//                 over, so do not reuse it). Resolves once there is room for
//                 more, which is what paces the source to the disk.
//   close()       finish the file. Resolves once the browser has taken it all.
//   abort()       fail the download and discard what was written.
// write and close reject with an AbortError if the user cancels the download
// in the browser.
export async function openFileSink(name, size) {
  const registration = await getWorker();
  if (!registration?.active) return null;

  const id = crypto.randomUUID();
  const { port1: port, port2 } = new MessageChannel();
  let unacked = 0;
  let failure = null;
  let lastHeard = Date.now();
  let frame = null;
  const waiters = new Set();
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const changed = () => new Promise((resolve) => waiters.add(resolve));

  // Resolved by the worker's 'ready' and 'started' messages.
  const milestones = {};
  const ready = new Promise((resolve) => { milestones.ready = resolve; });
  const started = new Promise((resolve) => { milestones.started = resolve; });

  port.onmessage = ({ data }) => {
    lastHeard = Date.now();
    if (data.type === 'ack') unacked -= data.bytes;
    else if (data.type === 'cancelled') failure ??= cancelled();
    else milestones[data.type]?.();
    wake();
  };

  // Two jobs: keep the browser from suspending the worker mid-download, and
  // notice if it did anyway (the worker then no longer answers on our port).
  const heartbeat = setInterval(() => {
    registration.active?.postMessage({ type: 'ping' });
    port.postMessage({ type: 'ping' });
    if (Date.now() - lastHeard > SILENCE_TIMEOUT_MS) {
      failure ??= new Error('The browser stopped the download.');
      wake();
    }
  }, PING_MS);

  const finish = () => {
    clearInterval(heartbeat);
    port.close();
    // The frame started the download; removing it straight away can cancel it.
    setTimeout(() => frame?.remove(), 60_000);
  };
  const abort = () => {
    port.postMessage({ type: 'abort' });
    failure ??= cancelled();
    wake();
    finish();
  };

  const within = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), SETUP_TIMEOUT_MS))]);

  registration.active.postMessage({ type: 'open', id, name, size }, [port2]);
  if ((await within(ready)) === 'timeout') {
    finish();
    return null;
  }
  // A hidden frame asks for the download; the worker answers it, and because
  // the answer is an attachment the browser saves it and the page stays put.
  frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `${registration.scope}${id}/${encodeURIComponent(name)}`;
  document.body.append(frame);
  if ((await within(started)) === 'timeout') {
    abort();
    return null;
  }

  return {
    async write(bytes) {
      if (failure) throw failure;
      const whole = bytes instanceof ArrayBuffer || bytes.byteLength === bytes.buffer.byteLength;
      const buffer = bytes instanceof ArrayBuffer ? bytes : whole ? bytes.buffer : bytes.slice().buffer;
      unacked += buffer.byteLength;
      port.postMessage({ type: 'chunk', bytes: buffer }, [buffer]);
      while (unacked > WINDOW_BYTES && !failure) await changed();
      if (failure) throw failure;
    },
    async close() {
      if (failure) throw failure;
      port.postMessage({ type: 'close' });
      while (unacked > 0 && !failure) await changed();
      finish();
      if (failure) throw failure;
    },
    abort,
  };
}
