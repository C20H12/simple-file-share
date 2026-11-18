// Download streaming worker.
//
// Some downloads are produced inside a page rather than fetched from a URL: a
// password-protected file is decrypted there, and a peer share arrives over a
// data channel. To save one without holding the whole file in memory, the page
// opens a "sink" here and then points a hidden frame at
//   <scope><id>/<file name>
// This worker answers that request with a streaming response, fed chunk by
// chunk by the page, and the browser writes it to disk as an ordinary
// download, with its usual progress display.
//
// The worker's scope is only its own folder, so it never touches the app's
// other requests.
//
// Messages
//   page -> worker, on the worker itself
//     { type: 'open', id, name, size }  with a MessagePort for this download
//     { type: 'ping' }                  keeps the browser from putting the worker to sleep
//   page -> worker, on the port
//     { type: 'chunk', bytes }          the next piece of the file (an ArrayBuffer)
//     { type: 'close' }                 no more pieces
//     { type: 'abort' }                 fail the download
//     { type: 'ping' }                  answered with 'pong', so the page can tell this download is still held
//   worker -> page, on the port
//     { type: 'ready' }                 the sink is registered
//     { type: 'started' }               the browser has asked for the download
//     { type: 'ack', bytes }            that many bytes were handed to the browser
//     { type: 'cancelled' }             the browser gave up on the download (the user cancelled it)

const scopePath = new URL(self.registration.scope).pathname;
const sinks = new Map(); // id -> sink the browser has not asked for yet

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function createSink({ name, size }, port) {
  const queue = []; // pieces from the page that the browser has not taken yet
  let controller;
  let wanted = null; // set while the browser is waiting for the next piece
  let closed = false;

  // Hands the browser one piece if it is waiting and one is available.
  const pump = () => {
    if (!wanted) return;
    if (queue.length) {
      const bytes = queue.shift();
      controller.enqueue(bytes);
      port.postMessage({ type: 'ack', bytes: bytes.byteLength });
    } else if (closed) {
      controller.close();
      port.close();
    } else {
      return;
    }
    const resume = wanted;
    wanted = null;
    resume();
  };

  const stream = new ReadableStream({
    start(c) { controller = c; },
    // Called each time the browser is ready for more: this is what holds the
    // page back to the speed the disk can take.
    pull() { return new Promise((resolve) => { wanted = resolve; pump(); }); },
    cancel() {
      port.postMessage({ type: 'cancelled' });
      port.close();
    },
  });

  port.onmessage = ({ data }) => {
    if (data.type === 'chunk') {
      queue.push(new Uint8Array(data.bytes));
    } else if (data.type === 'close') {
      closed = true;
    } else if (data.type === 'ping') {
      port.postMessage({ type: 'pong' });
      return;
    } else if (data.type === 'abort') {
      controller.error(new Error('The download was stopped.'));
      wanted?.();
      wanted = null;
      port.close();
      return;
    }
    pump();
  };

  return { name, size, stream, port };
}

self.addEventListener('message', (event) => {
  const { data, ports } = event;
  // A 'ping' needs no handling: receiving it is what keeps the worker awake.
  if (data?.type !== 'open' || !ports[0]) return;
  sinks.set(data.id, createSink(data, ports[0]));
  ports[0].postMessage({ type: 'ready' });
});

// RFC 5987 encoding, so any file name survives the trip through a header.
const headerName = (name) => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

self.addEventListener('fetch', (event) => {
  const { pathname } = new URL(event.request.url);
  if (!pathname.startsWith(scopePath)) return;
  const id = pathname.slice(scopePath.length).split('/')[0];
  const sink = sinks.get(id);
  if (!sink) {
    // Every response from here is plain text or an attachment, never a page.
    event.respondWith(new Response('This download is no longer available.', { status: 410, headers: { 'Content-Type': 'text/plain' } }));
    return;
  }
  sinks.delete(id);
  sink.port.postMessage({ type: 'started' });
  event.respondWith(new Response(sink.stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${headerName(sink.name)}`,
      'Content-Length': String(sink.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  }));
});
