// Peer share: files go straight from the sender's browser to the receiver's
// over a WebRTC data channel. The backend only introduces the two browsers
// (PeerJS signaling at /peer); file data never passes through it.
//
// The sender's PeerJS id is the share code: the sender asks for no id of its
// own, so the server generates one, and it generates 6-digit codes. Receivers
// use a random id, so they never occupy a code.
//
// Protocol, over one PeerJS connection opened by the receiver. Text frames are
// JSON control messages, binary frames are file data:
//
//   receiver                               sender
//   { type: 'list' }                  ->
//                                     <-   { type: 'list', files: [{ id, name, size, type }] }
//   { type: 'get', req, id, offset }  ->
//                                     <-   { type: 'start', req }
//                                     <-   the file's bytes from `offset`, as binary frames
//   { type: 'ack', req, bytes }       ->   (how much of the file the receiver has stored so far)
//                                     <-   { type: 'end', req }  or  { type: 'error', req, message }
//   { type: 'cancel', req }           ->   (the sender stops and answers with an error)
//
// A connection carries one transfer at a time; further requests wait their
// turn. `offset` asks for the file from that byte on; this receiver always
// asks from 0, since a download cut off by a lost connection is stopped
// rather than left open to resume. The acknowledgements keep the sender within a
// fixed distance of what the receiver has actually stored, so a receiver whose
// disk is slower than the network is never flooded.
import { blobType, saveBlob } from './download.js';
import { openFileSink } from './fileSink.js';

// 16 KiB is the largest frame every browser pairing delivers in one piece.
const FRAME_BYTES = 16 * 1024;
const READ_BYTES = 1024 * 1024; // how much of a file the sender reads at a time
// The sender pauses while more than HIGH_WATER is queued on the channel and
// resumes below LOW_WATER, so a fast disk never outruns a slow network.
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
// How far the sender may run ahead of the receiver's acknowledgements.
const WINDOW_BYTES = 16 * 1024 * 1024;
// A receiver gathers frames into pieces this size before storing them.
const BATCH_BYTES = 1024 * 1024;
// When a file is kept in memory, its pieces are folded into a Blob this often,
// which lets the browser move them out of the page's own memory.
const FOLD_PIECES = 16;
const CONNECT_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 20_000;
const MAX_LISTED_FILES = 1000;

// kind: 'unavailable' nobody is hosting that code
//       'lost'        the connection dropped
//       'refused'     the sender could not send the file (message says why)
//       'failed'      anything else
export class PeerError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function peerOptions() {
  const server = new URL(import.meta.env.VITE_API_URL || window.location.origin);
  const secure = server.protocol === 'https:';
  // Without VITE_ICE_SERVERS, PeerJS uses its default STUN/TURN servers.
  const ice = import.meta.env.VITE_ICE_SERVERS;
  return {
    host: server.hostname,
    port: Number(server.port) || (secure ? 443 : 80),
    path: import.meta.env.VITE_PEER_PATH || '/peer',
    secure,
    ...(ice ? { config: { iceServers: JSON.parse(ice) } } : {}),
    debug: Number(import.meta.env.VITE_PEER_DEBUG) || 0, // 0 silent … 3 everything, to the console
  };
}

// Resolves once the peer is registered with the signaling server.
const registered = (peer) => new Promise((resolve, reject) => {
  peer.once('open', resolve);
  peer.once('error', reject);
});

const withTimeout = (promise, ms, onTimeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(onTimeout()), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

const say = (conn, message) => { if (conn.open) conn.send(JSON.stringify(message)); };

const parse = (data) => {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

// Resolves when the channel has room for more data (or has closed).
function drained(conn) {
  const channel = conn.dataChannel;
  if (!channel || channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      clearInterval(poll);
      resolve();
    };
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.addEventListener('bufferedamountlow', done);
    // Fallback in case the event is missed or the channel closes while waiting.
    const poll = setInterval(() => {
      if (channel.readyState !== 'open' || channel.bufferedAmount <= LOW_WATER) done();
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

// Shares File objects with anyone who connects using the returned code. The
// files are read from disk only as receivers ask for them.
//
// onChange receives { status, percent } whenever either changes:
//   waiting       no receiver is connected
//   connected     a receiver is connected and idle
//   transferring  a file is being sent
//   complete      every file has been sent in full at least once
//   lost          a receiver dropped off in the middle of a file
// percent is how much of the share has been sent, counting each file's
// furthest progress.
//
// Resolves with { code, stop } once the share is reachable.
export async function hostFiles(files, onChange) {
  const { Peer } = await import('peerjs');
  const peer = new Peer(peerOptions()); // no id given: the server issues the 6-digit code

  const manifest = files.map((file, i) => ({ id: String(i), name: file.name, size: file.size, type: file.type }));
  const fileById = new Map(manifest.map((entry, i) => [entry.id, files[i]]));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.size, 0);

  const sent = new Map(); // file id -> most bytes sent to any receiver
  const delivered = new Set(); // ids of files sent in full
  const connections = new Set();
  let transfers = 0;
  let lost = false;
  let stopped = false;

  const snapshot = () => {
    const complete = delivered.size === manifest.length;
    const sentBytes = manifest.reduce((sum, entry) => sum + (sent.get(entry.id) ?? 0), 0);
    let status = 'waiting';
    if (transfers > 0) status = 'transferring';
    else if (complete) status = 'complete';
    else if (lost) status = 'lost';
    else if (connections.size > 0) status = 'connected';
    return { status, percent: complete ? 100 : Math.min(99, totalBytes ? Math.floor((sentBytes / totalBytes) * 100) : 0) };
  };

  // A change of status is reported at once. Progress within a status is
  // reported at most ten times a second. (Only the latter waits on a timer,
  // which browsers slow right down in a background tab.)
  let lastEmit = 0;
  let lastStatus = null;
  let trailing = null;
  const emit = () => {
    if (stopped) return;
    const state = snapshot();
    const wait = 100 - (Date.now() - lastEmit);
    if (state.status === lastStatus && wait > 0) {
      trailing ??= setTimeout(() => { trailing = null; emit(); }, wait);
      return;
    }
    lastEmit = Date.now();
    lastStatus = state.status;
    onChange?.(state);
  };

  async function transfer(conn, { req, id, offset = 0 }, state) {
    const file = fileById.get(id);
    if (!file || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size) {
      say(conn, { type: 'error', req, message: 'That file is not part of this share.' });
      return;
    }
    transfers += 1;
    lost = false;
    emit();
    state.acked = offset;
    // 'start' is held back until the first read succeeds, so a file that can
    // no longer be read is refused before the receiver begins saving it.
    let announced = false;
    const announce = () => {
      if (!announced) say(conn, { type: 'start', req });
      announced = true;
    };
    try {
      for (let position = offset; position < file.size;) {
        // Wait while the receiver is a full window behind in storing what it was sent.
        while (position - state.acked > WINDOW_BYTES && !state.cancelled && conn.open) {
          await new Promise((resolve) => {
            state.wake = resolve;
            setTimeout(resolve, 1000);
          });
        }
        const block = await file.slice(position, position + READ_BYTES).arrayBuffer();
        announce();
        for (let at = 0; at < block.byteLength; at += FRAME_BYTES) {
          await drained(conn);
          if (state.cancelled || !conn.open) throw new PeerError(conn.open ? 'refused' : 'lost', 'The transfer was cancelled.');
          conn.send(block.slice(at, at + FRAME_BYTES));
        }
        position += block.byteLength;
        sent.set(id, Math.max(sent.get(id) ?? 0, position));
        emit();
      }
      announce(); // an empty file, or a resume from its very end
      say(conn, { type: 'end', req });
      delivered.add(id);
    } catch (err) {
      if (err.kind === 'lost') lost = true;
      // Anything else here is the file itself: moved, deleted or changed since it was picked.
      else say(conn, { type: 'error', req, message: err.kind ? err.message : 'The sender can no longer read this file.' });
    } finally {
      transfers -= 1;
      emit();
    }
  }

  function serve(conn) {
    let queue = Promise.resolve();
    const requests = new Map(); // req -> { cancelled }

    conn.on('open', () => {
      connections.add(conn);
      lost = false;
      emit();
    });
    conn.on('data', (data) => {
      const message = parse(data);
      if (message?.type === 'list') {
        say(conn, { type: 'list', files: manifest });
      } else if (message?.type === 'get') {
        const state = { cancelled: false, acked: 0, wake: null };
        requests.set(message.req, state);
        queue = queue.then(() => transfer(conn, message, state)).finally(() => requests.delete(message.req));
      } else if (message?.type === 'ack') {
        const state = requests.get(message.req);
        if (state && Number.isSafeInteger(message.bytes)) {
          state.acked = Math.max(state.acked, message.bytes);
          state.wake?.();
        }
      } else if (message?.type === 'cancel') {
        const state = requests.get(message.req);
        if (state) {
          state.cancelled = true;
          state.wake?.();
        }
      }
    });
    const gone = () => {
      if (!connections.delete(conn)) return;
      for (const state of requests.values()) {
        state.cancelled = true;
        state.wake?.();
      }
      if (requests.size) lost = true;
      emit();
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(trailing);
    window.removeEventListener('pagehide', stop);
    peer.destroy(); // closes every connection, which tells receivers straight away
  };

  try {
    await withTimeout(registered(peer), CONNECT_TIMEOUT_MS, () => new PeerError('failed', 'The server did not answer.'));
  } catch (err) {
    stop();
    throw err;
  }

  peer.on('connection', serve);
  // If the link to the signaling server drops, existing transfers carry on;
  // reconnect so new receivers can still find the share under the same code.
  peer.on('disconnected', () => {
    setTimeout(() => { if (!stopped && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1000);
  });
  window.addEventListener('pagehide', stop);
  emit();

  return { code: peer.id, stop };
}

// ---------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------

// A sender is someone else's browser, so its file list is checked like any
// other outside input before it is used.
function checkList(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_LISTED_FILES) return null;
  const ok = files.every((f) => f
    && typeof f.id === 'string' && f.id.length <= 64
    && typeof f.name === 'string' && f.name.length >= 1 && f.name.length <= 255
    && Number.isSafeInteger(f.size) && f.size >= 0);
  if (!ok || new Set(files.map((f) => f.id)).size !== files.length) return null;
  return files.map(({ id, name, size, type }) => ({ id, name, size, type: typeof type === 'string' ? type.slice(0, 255) : '' }));
}

// Where a file being received is put. In memory, as a Blob, in browsers that
// cannot stream to disk.
function memoryTarget(name) {
  let blobs = [];
  let pieces = [];
  return {
    write(bytes) {
      pieces.push(bytes);
      if (pieces.length < FOLD_PIECES) return;
      blobs.push(new Blob(pieces));
      pieces = [];
    },
    finish: () => new Blob([...blobs, ...pieces], { type: blobType(name) }),
    discard() { blobs = []; pieces = []; },
  };
}

// Or on disk, through a browser download that is written as the bytes arrive.
const diskTarget = (sink) => ({
  write: (bytes) => sink.write(bytes),
  finish: () => sink.close(),
  discard: () => sink.abort(),
});

const abortError = () => new DOMException('Aborted', 'AbortError');

// Connects to the sender hosting `code` and fetches its file list.
//
//   signal    aborting it abandons the attempt
//   onPhase   called with 'listing' once connected, while the list is fetched
//   onLost    called if the connection drops after this has resolved
//
// Resolves with { files, save, close }.
//   save(file, { onProgress, signal })  saves the file, writing it to disk as it
//                                       arrives where the browser allows;
//                                       onProgress receives the bytes so far
export async function connectToHost(code, { signal, onPhase, onLost } = {}) {
  const { Peer } = await import('peerjs');
  const options = peerOptions();
  // Abandoned before it began (for example the page was left straight away):
  // stop here rather than open a connection only to drop it.
  if (signal?.aborted) throw abortError();
  const peer = new Peer(crypto.randomUUID(), options);
  let conn = null;
  let ended = false; // closed on purpose or lost; either way nothing more will arrive
  let current = null; // the transfer in progress
  let listWaiter = null;
  let tail = Promise.resolve();
  let nextRequest = 1;
  const lostError = () => new PeerError('lost', 'The connection to the sender was lost.');

  const end = (lost) => {
    if (ended) return;
    ended = true;
    window.removeEventListener('pagehide', close);
    signal?.removeEventListener('abort', close);
    listWaiter?.reject(lostError());
    current?.fail(lostError());
    peer.destroy();
    if (lost) onLost?.();
  };
  const close = () => end(false);
  const lose = () => end(true);

  const onData = (data) => {
    if (typeof data !== 'string') {
      if (current?.started) current.onBytes(data);
      return;
    }
    const message = parse(data);
    if (message?.type === 'list') listWaiter?.resolve(message.files);
    else if (!current || message?.req !== current.req) return;
    else if (message.type === 'start') current.onStart();
    else if (message.type === 'end') current.onEnd();
    else if (message.type === 'error') current.onError(String(message.message ?? 'The sender refused the request.'));
  };

  // Receives one file, written to disk as it arrives where the browser allows.
  // Resolves with nothing in that case, otherwise with the file as a Blob.
  // If the connection ends part-way (dropped, or the page is left), the
  // download is stopped and what was written is discarded, rather than left
  // open in the browser waiting for data that will not come.
  const receive = (file, { onProgress, signal: stopSignal } = {}) => {
    const run = async () => {
      if (ended) throw lostError();
      if (stopSignal?.aborted) throw abortError();

      const partial = {
        target: null, // opened when the sender starts sending
        opening: false,
        discarded: false,
        batch: new Uint8Array(BATCH_BYTES), // frames gathered so far towards the next piece
        filled: 0,
        received: 0, // bytes that have arrived from the sender
        written: 0, // bytes the target has accepted
        chain: Promise.resolve(), // opening the target, then its writes, in order
        discard() {
          this.discarded = true;
          this.target?.discard();
        },
      };
      // The browser download is begun only once the sender confirms it can
      // send the file, so a refused request leaves nothing behind.
      const openTarget = () => {
        if (partial.target || partial.opening) return;
        partial.opening = true;
        partial.chain = partial.chain.then(async () => {
          const sink = await openFileSink(file.name, file.size);
          partial.target = sink ? diskTarget(sink) : memoryTarget(file.name);
          if (partial.discarded) partial.target.discard();
        });
      };

      return new Promise((resolve, reject) => {
        const req = nextRequest++;
        let stall;
        // If nothing arrives for a while the connection is dead, unless the
        // sender is only waiting for this side to finish storing what it has.
        const watch = () => {
          clearTimeout(stall);
          stall = setTimeout(() => {
            if (partial.written + partial.filled < partial.received) watch();
            else lose();
          }, STALL_TIMEOUT_MS);
        };
        const settle = (settler, value) => {
          clearTimeout(stall);
          stopSignal?.removeEventListener('abort', abandon);
          if (current?.req === req) current = null;
          settler(value);
        };
        // Gives this file up, telling the sender to stop.
        const drop = (err) => {
          if (current?.req !== req) return;
          say(conn, { type: 'cancel', req });
          partial.discard();
          settle(reject, err);
        };
        const abandon = () => drop(abortError());
        stopSignal?.addEventListener('abort', abandon);

        // Stores a piece, then tells the sender how far the file has got.
        const store = (bytes) => {
          const size = bytes.byteLength; // read now: writing to disk hands the buffer away, leaving it empty
          partial.chain = partial.chain.then(() => partial.target.write(bytes)).then(() => {
            partial.written += size;
            say(conn, { type: 'ack', req, bytes: partial.written });
            if (current?.req === req) watch();
          });
          // A failed write is the user cancelling the browser download, or the browser stopping it.
          partial.chain.catch(drop);
        };

        current = {
          req,
          started: false,
          onStart() {
            this.started = true;
            openTarget();
          },
          onBytes(buffer) {
            const bytes = new Uint8Array(buffer);
            partial.received += bytes.length;
            if (partial.received > file.size) return drop(new PeerError('failed', 'The sender sent more data than the file holds.'));
            for (let offset = 0; offset < bytes.length;) {
              const n = Math.min(BATCH_BYTES - partial.filled, bytes.length - offset);
              partial.batch.set(bytes.subarray(offset, offset + n), partial.filled);
              partial.filled += n;
              offset += n;
              if (partial.filled === BATCH_BYTES) {
                store(partial.batch.buffer);
                partial.batch = new Uint8Array(BATCH_BYTES);
                partial.filled = 0;
              }
            }
            onProgress?.(partial.received);
            watch();
          },
          onEnd() {
            if (partial.received !== file.size) return drop(new PeerError('failed', 'The file arrived incomplete.'));
            if (partial.filled) {
              store(partial.batch.slice(0, partial.filled).buffer);
              partial.filled = 0;
            }
            clearTimeout(stall); // the sender is done; only storing remains
            partial.chain.then(() => partial.target.finish()).then((result) => settle(resolve, result), drop);
          },
          onError(message) { drop(new PeerError('refused', message)); },
          // The connection ended: stop the browser download and discard it.
          fail(err) {
            partial.discard();
            settle(reject, err);
          },
        };
        say(conn, { type: 'get', req, id: file.id, offset: 0 });
        watch();
      });
    };
    const result = tail.then(run);
    tail = result.catch(() => {}); // one failed download must not block the next
    return result;
  };

  const save = async (file, options) => {
    const blob = await receive(file, options);
    if (blob) saveBlob(blob, file.name); // this browser could not stream to disk
  };

  try {
    signal?.addEventListener('abort', close);
    const aborted = new Promise((_, reject) => signal?.addEventListener('abort', () => reject(abortError())));
    const timedOut = () => new PeerError('failed', 'The sender did not answer.');

    await withTimeout(Promise.race([registered(peer), aborted]), CONNECT_TIMEOUT_MS, timedOut);

    conn = peer.connect(code, { reliable: true, serialization: 'raw' });
    await withTimeout(Promise.race([aborted, new Promise((resolve, reject) => {
      conn.once('open', resolve);
      conn.once('error', () => reject(new PeerError('failed', 'The connection could not be set up.')));
      // The signaling server reports a code nobody is hosting as a peer error.
      peer.on('error', (err) => reject(new PeerError(err.type === 'peer-unavailable' ? 'unavailable' : 'failed', err.message)));
    })]), CONNECT_TIMEOUT_MS, timedOut);

    conn.on('data', onData);
    conn.on('close', lose);
    conn.on('error', lose);
    window.addEventListener('pagehide', close);

    onPhase?.('listing');
    say(conn, { type: 'list' });
    const listed = await withTimeout(Promise.race([aborted, new Promise((resolve, reject) => { listWaiter = { resolve, reject }; })]), CONNECT_TIMEOUT_MS, timedOut);
    listWaiter = null;
    const files = checkList(listed);
    if (!files) throw new PeerError('failed', 'The sender sent a file list that could not be read.');

    signal?.removeEventListener('abort', close);
    return { files, save, close };
  } catch (err) {
    listWaiter = null;
    close();
    throw err;
  }
}
