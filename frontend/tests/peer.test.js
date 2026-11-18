// Peer share, sender and receiver, run against each other over a fake PeerJS
// (see fakePeerjs.js) so the protocol in src/lib/peer.js is exercised end to
// end without WebRTC.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { network, Peer as FakePeer } from './fakePeerjs.js';
import { memorySink, pattern, sameBytes, until } from './helpers.js';

vi.mock('peerjs', () => import('./fakePeerjs.js'));
vi.mock('../src/lib/fileSink.js', () => ({ openFileSink: vi.fn() }));
vi.mock('../src/lib/download.js', async (importOriginal) => ({ ...(await importOriginal()), saveBlob: vi.fn() }));

const { openFileSink } = await import('../src/lib/fileSink.js');
const { saveBlob } = await import('../src/lib/download.js');
const { PeerError, connectToHost, hostFiles } = await import('../src/lib/peer.js');

const MiB = 1024 * 1024;

let sinks;
let hosts;
let receivers;

beforeEach(() => {
  network.reset();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'http://127.0.0.1:5173' } }));
  sinks = [];
  hosts = [];
  receivers = [];
  openFileSink.mockImplementation(async () => {
    const sink = memorySink({ transfer: true });
    sinks.push(sink);
    return sink;
  });
});

afterEach(() => {
  for (const r of receivers) r.close();
  for (const h of hosts) h.stop();
});

// Starts a share and records its status reports.
async function host(files) {
  const states = [];
  const shared = await hostFiles(files, (state) => states.push(state));
  hosts.push(shared);
  return { ...shared, states, last: () => states.at(-1) };
}

async function connect(code, options) {
  const found = await connectToHost(code, options);
  receivers.push(found);
  return found;
}

const file = (name, bytes, type = '') => new File([bytes], name, { type });

// Everything the receiver side of every connection sent, in order.
const receiverMessages = () => network.connections.filter((c) => c.side === 'receiver').flatMap((c) => c.sent);

// Messages the sender side sent over all its connections, including closed ones.
function trackSenderMessages() {
  const seen = [];
  network.onSend = (conn, data) => { if (conn.side === 'sender' && typeof data === 'string') seen.push(JSON.parse(data)); };
  return seen;
}

describe('hosting', () => {
  test('the code is the id the signaling server issues, and the sender starts out waiting', async () => {
    const shared = await host([file('a.txt', 'hello')]);
    expect(shared.code).toBe('100000');
    expect(network.peers.get('100000')).toBeDefined();
    expect(shared.last()).toEqual({ status: 'waiting', percent: 0 });
  });

  test('connects to this backend’s signaling endpoint and leaves ICE servers to PeerJS', async () => {
    await host([file('a.txt', 'hello')]);
    expect(network.created[0].options).toEqual({ host: '127.0.0.1', port: 5173, path: '/peer', secure: false, debug: 0 });
  });

  test('VITE_ICE_SERVERS overrides the ICE servers', async () => {
    vi.stubEnv('VITE_ICE_SERVERS', '[{"urls":"stun:stun.example.test:3478"}]');
    try {
      await host([file('a.txt', 'hello')]);
      expect(network.created[0].options.config).toEqual({ iceServers: [{ urls: 'stun:stun.example.test:3478' }] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('stop ends the share: the code no longer answers', async () => {
    const shared = await host([file('a.txt', 'hello')]);
    shared.stop();
    await expect(connectToHost(shared.code)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('connecting', () => {
  test('fetches the file list first', async () => {
    const shared = await host([file('photo.png', pattern(10), 'image/png'), file('notes.txt', 'hi')]);
    const onPhase = vi.fn();
    const found = await connect(shared.code, { onPhase });
    expect(onPhase).toHaveBeenCalledWith('listing');
    expect(found.files).toEqual([
      { id: '0', name: 'photo.png', size: 10, type: 'image/png' },
      { id: '1', name: 'notes.txt', size: 2, type: '' },
    ]);
    expect(receiverMessages()).toEqual([{ type: 'list' }]);
    await until(() => shared.last().status === 'connected');
  });

  test('a code nobody hosts is reported as unavailable', async () => {
    const err = await connectToHost('999999').catch((e) => e);
    expect(err).toBeInstanceOf(PeerError);
    expect(err.kind).toBe('unavailable');
  });

  test('an attempt abandoned before it starts opens no connection', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(connectToHost('100000', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(network.created).toHaveLength(0);
  });

  test('closing the receiver tells the sender', async () => {
    const shared = await host([file('a.txt', 'hello')]);
    const found = await connect(shared.code);
    await until(() => shared.last().status === 'connected');
    found.close();
    await until(() => shared.last().status === 'waiting');
  });

  test('the sender stopping is reported to a connected receiver as lost', async () => {
    const shared = await host([file('a.txt', 'hello')]);
    const onLost = vi.fn();
    await connect(shared.code, { onLost });
    shared.stop();
    await until(() => onLost.mock.calls.length === 1);
  });
});

describe('downloading', () => {
  test('a file is requested by id and written to disk as it arrives, byte for byte', async () => {
    const bytes = pattern(3 * MiB + 123);
    const shared = await host([file('big.bin', bytes)]);
    const found = await connect(shared.code);
    const onProgress = vi.fn();

    await found.save(found.files[0], { onProgress });

    expect(openFileSink).toHaveBeenCalledWith('big.bin', bytes.length);
    const [sink] = sinks;
    expect(sameBytes(sink.bytes(), bytes)).toBe(true);
    expect(sink.closed).toBe(true);
    expect(sink.chunks.slice(0, 3).map((c) => c.length)).toEqual([MiB, MiB, MiB]); // gathered into 1 MiB writes
    expect(onProgress).toHaveBeenLastCalledWith(bytes.length);
    expect(receiverMessages()).toContainEqual({ type: 'get', req: 1, id: '0', offset: 0 });
    expect(saveBlob).not.toHaveBeenCalled();
    await until(() => shared.last().status === 'complete');
    expect(shared.last().percent).toBe(100);
  });

  test('acknowledges what has been stored, up to the whole file', async () => {
    const bytes = pattern(2 * MiB + 5);
    const shared = await host([file('a.bin', bytes)]);
    const found = await connect(shared.code);
    await found.save(found.files[0]);
    const acks = receiverMessages().filter((m) => m.type === 'ack').map((m) => m.bytes);
    expect(acks).toEqual([MiB, 2 * MiB, 2 * MiB + 5]);
  });

  test('an empty file is saved too', async () => {
    const shared = await host([file('empty.txt', '')]);
    const found = await connect(shared.code);
    await found.save(found.files[0]);
    expect(sinks[0].bytes().length).toBe(0);
    expect(sinks[0].closed).toBe(true);
  });

  test('where the browser cannot stream to disk, the file is built in memory and handed over', async () => {
    openFileSink.mockResolvedValue(null);
    const bytes = pattern(1.5 * MiB);
    const shared = await host([file('scan.pdf', bytes)]);
    const found = await connect(shared.code);
    await found.save(found.files[0]);
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0];
    expect(name).toBe('scan.pdf');
    expect(blob.type).toBe('application/pdf');
    expect(sameBytes(new Uint8Array(await blob.arrayBuffer()), bytes)).toBe(true);
  });

  test('requests made together are sent one at a time, in order', async () => {
    const shared = await host([file('a.bin', pattern(MiB + 1, 1)), file('b.bin', pattern(MiB + 2, 2))]);
    const found = await connect(shared.code);
    const fromSender = trackSenderMessages();
    await Promise.all(found.files.map((f) => found.save(f)));
    expect(fromSender.map((m) => `${m.type} ${m.req}`)).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    expect(sameBytes(sinks[0].bytes(), pattern(MiB + 1, 1))).toBe(true);
    expect(sameBytes(sinks[1].bytes(), pattern(MiB + 2, 2))).toBe(true);
  });

  test('two receivers can download from the same share at once', async () => {
    const bytes = pattern(MiB + 7);
    const shared = await host([file('a.bin', bytes)]);
    // Connected one after the other: Vitest hands the real PeerJS to the second
    // of two concurrent dynamic imports of a mocked module.
    const one = await connect(shared.code);
    const two = await connect(shared.code);
    await Promise.all([one.save(one.files[0]), two.save(two.files[0])]);
    expect(sinks).toHaveLength(2);
    for (const sink of sinks) expect(sameBytes(sink.bytes(), bytes)).toBe(true);
  });
});

describe('refusals and failures', () => {
  test('a file the sender can no longer read is refused before any download starts', async () => {
    const unreadable = { name: 'moved.txt', size: 100, type: 'text/plain', slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) };
    const shared = await host([unreadable]);
    const found = await connect(shared.code);
    const err = await found.save(found.files[0]).catch((e) => e);
    expect(err).toBeInstanceOf(PeerError);
    expect(err.kind).toBe('refused');
    expect(err.message).toBe('The sender can no longer read this file.');
    expect(openFileSink).not.toHaveBeenCalled();
  });

  test('a failed file does not block the next one', async () => {
    const unreadable = { name: 'moved.txt', size: 100, type: '', slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }) };
    const shared = await host([unreadable, file('ok.txt', 'fine')]);
    const found = await connect(shared.code);
    const results = await Promise.allSettled(found.files.map((f) => found.save(f)));
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(sinks[0].bytes().toString()).toBe('fine');
  });

  test('cancelling a download tells the sender to stop and abandons the file', async () => {
    const shared = await host([file('big.bin', pattern(8 * MiB))]);
    const found = await connect(shared.code);
    const fromSender = trackSenderMessages();
    const controller = new AbortController();
    const saving = found.save(found.files[0], { signal: controller.signal, onProgress: (n) => { if (n > MiB) controller.abort(); } });
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' });
    expect(receiverMessages()).toContainEqual({ type: 'cancel', req: 1 });
    await until(() => fromSender.some((m) => m.type === 'error' && m.req === 1));
    expect(sinks[0].aborted).toBe(true);
  });

  test('the user cancelling the browser download cancels the transfer', async () => {
    openFileSink.mockImplementation(async () => {
      const sink = memorySink();
      sink.write.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
      sinks.push(sink);
      return sink;
    });
    const shared = await host([file('big.bin', pattern(4 * MiB))]);
    const found = await connect(shared.code);
    await expect(found.save(found.files[0])).rejects.toMatchObject({ name: 'AbortError' });
    expect(receiverMessages()).toContainEqual({ type: 'cancel', req: 1 });
  });
});

describe('dropped connections', () => {
  // Cuts the connection once the sender has sent `bytes` of file data on it.
  function dropAfter(bytes) {
    let sent = 0;
    network.onSend = (conn, data) => {
      if (conn.side !== 'sender' || typeof data === 'string' || sent >= bytes) return;
      sent += data.byteLength;
      if (sent >= bytes) conn.close();
    };
  }

  test('a drop mid-file stops the browser download and discards what was written', async () => {
    const shared = await host([file('big.bin', pattern(5 * MiB + 321))]);
    const onLost = vi.fn();
    const found = await connect(shared.code, { onLost });
    dropAfter(2.5 * MiB);

    const err = await found.save(found.files[0]).catch((e) => e);
    expect(err).toBeInstanceOf(PeerError);
    expect(err.kind).toBe('lost');
    expect(onLost).toHaveBeenCalledTimes(1);
    await until(() => sinks[0].aborted);
    expect(sinks[0].closed).toBe(false);
    await until(() => shared.last().status === 'lost');
    expect(shared.last().percent).toBeGreaterThan(0);
  });

  test('after reconnecting, the file downloads again from the start as a new download', async () => {
    const bytes = pattern(5 * MiB + 321);
    const shared = await host([file('big.bin', bytes)]);
    const first = await connect(shared.code);
    dropAfter(2.5 * MiB);
    await expect(first.save(first.files[0])).rejects.toMatchObject({ kind: 'lost' });

    network.onSend = null;
    const second = await connect(shared.code);
    await second.save(second.files[0]);

    const gets = receiverMessages().filter((m) => m.type === 'get');
    expect(gets.map((m) => m.offset)).toEqual([0, 0]);
    expect(openFileSink).toHaveBeenCalledTimes(2);
    expect(sinks[0].aborted).toBe(true);
    expect(sameBytes(sinks[1].bytes(), bytes)).toBe(true);
    expect(sinks[1].closed).toBe(true);
    await until(() => shared.last().status === 'complete');
  });

  test('leaving the page mid-download stops the browser download too', async () => {
    const shared = await host([file('big.bin', pattern(4 * MiB))]);
    const onLost = vi.fn();
    const found = await connect(shared.code, { onLost });
    const saving = found.save(found.files[0], { onProgress: (n) => { if (n > MiB) found.close(); } });
    await expect(saving).rejects.toMatchObject({ kind: 'lost' });
    await until(() => sinks[0].aborted);
    expect(sinks[0].closed).toBe(false);
    expect(onLost).not.toHaveBeenCalled(); // closed on purpose, not lost
  });

  test('saving after the connection is gone fails at once as lost', async () => {
    const shared = await host([file('a.txt', 'hello')]);
    const found = await connect(shared.code);
    shared.stop();
    await until(() => network.created.at(-1).destroyed);
    await expect(found.save(found.files[0])).rejects.toMatchObject({ kind: 'lost' });
  });
});

describe('flow control', () => {
  test('the sender stays within 16 MiB of what the receiver has stored', async () => {
    const bytes = pattern(24 * MiB);
    // A disk that accepts the first piece and then stalls until released.
    let release;
    const stalled = new Promise((resolve) => { release = resolve; });
    openFileSink.mockImplementation(async () => {
      const sink = memorySink({ transfer: true });
      const write = sink.write.getMockImplementation();
      sink.write.mockImplementation(async function slow(chunk) {
        if (sink.chunks.length >= 1) await stalled;
        return write.call(this, chunk);
      });
      sinks.push(sink);
      return sink;
    });
    let sentBytes = 0;
    network.onSend = (conn, data) => { if (conn.side === 'sender' && typeof data !== 'string') sentBytes += data.byteLength; };

    const shared = await host([file('huge.bin', bytes)]);
    const found = await connect(shared.code);
    const saving = found.save(found.files[0]);

    // Wait for the sender to stop sending, then check how far ahead it got.
    let last = -1;
    await until(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = sentBytes === last && sentBytes > 0;
      last = sentBytes;
      return settled;
    }, { timeout: 10_000 });
    const acked = MiB; // only the first piece was stored
    expect(sentBytes).toBeLessThanOrEqual(acked + 16 * MiB + MiB); // the window, plus the block in hand
    expect(sentBytes).toBeLessThan(bytes.length);

    release();
    await saving;
    expect(sameBytes(sinks[0].bytes(), bytes)).toBe(true);
  }, 20_000);
});

describe('checking what the other side sends', () => {
  // A hand-driven peer, to send what a well-behaved one never would.
  async function rawPeer(id) {
    const peer = new FakePeer(id, {});
    await new Promise((resolve) => peer.once('open', resolve));
    return peer;
  }

  test('the sender refuses ids that are not in the share and offsets past the end', async () => {
    const shared = await host([file('a.txt', 'hello')]);
    const client = await rawPeer('raw-client');
    const conn = client.connect(shared.code);
    await new Promise((resolve) => conn.once('open', resolve));
    const replies = [];
    conn.on('data', (data) => replies.push(JSON.parse(data)));
    conn.send(JSON.stringify({ type: 'get', req: 1, id: '7', offset: 0 }));
    conn.send(JSON.stringify({ type: 'get', req: 2, id: '0', offset: 6 }));
    conn.send(JSON.stringify({ type: 'get', req: 3, id: '0', offset: -1 }));
    conn.send('not json');
    conn.send(JSON.stringify({ type: 'list' }));
    await until(() => replies.length === 4);
    // The list is answered at once; requests wait their turn in the transfer queue.
    expect(replies).toEqual([
      { type: 'list', files: [{ id: '0', name: 'a.txt', size: 5, type: '' }] },
      { type: 'error', req: 1, message: 'That file is not part of this share.' },
      { type: 'error', req: 2, message: 'That file is not part of this share.' },
      { type: 'error', req: 3, message: 'That file is not part of this share.' },
    ]);
    client.destroy();
  });

  // A sender that answers the list request with `files` and then runs `onGet`.
  async function fakeSender(code, files, onGet = () => {}) {
    const peer = await rawPeer(code);
    peer.on('connection', (conn) => {
      conn.on('data', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'list') conn.send(JSON.stringify({ type: 'list', files }));
        if (message.type === 'get') onGet(conn, message);
      });
    });
    return peer;
  }

  test.each([
    ['no files', []],
    ['not a list', { 0: 'x' }],
    ['a missing name', [{ id: 'a', size: 1 }]],
    ['a negative size', [{ id: 'a', name: 'x', size: -1 }]],
    ['a fractional size', [{ id: 'a', name: 'x', size: 1.5 }]],
    ['duplicate ids', [{ id: 'a', name: 'x', size: 1 }, { id: 'a', name: 'y', size: 1 }]],
    ['an overlong name', [{ id: 'a', name: 'x'.repeat(256), size: 1 }]],
  ])('the receiver rejects a file list with %s', async (_, files) => {
    const sender = await fakeSender('200000', files);
    await expect(connectToHost('200000')).rejects.toMatchObject({ kind: 'failed', message: 'The sender sent a file list that could not be read.' });
    sender.destroy();
  });

  test('the receiver keeps only the fields it uses and trims the type', async () => {
    const sender = await fakeSender('200001', [{ id: 'a', name: 'x.txt', size: 1, type: 't'.repeat(300), extra: '<script>' }]);
    const found = await connect('200001');
    expect(found.files).toEqual([{ id: 'a', name: 'x.txt', size: 1, type: 't'.repeat(255) }]);
    sender.destroy();
  });

  test('the receiver abandons a file when the sender sends more than its size', async () => {
    const sender = await fakeSender('200002', [{ id: 'a', name: 'x.bin', size: 10 }], (conn, { req }) => {
      conn.send(JSON.stringify({ type: 'start', req }));
      conn.send(new Uint8Array(11).buffer);
    });
    const found = await connect('200002');
    await expect(found.save(found.files[0])).rejects.toMatchObject({ kind: 'failed', message: 'The sender sent more data than the file holds.' });
    expect(receiverMessages()).toContainEqual({ type: 'cancel', req: 1 });
    sender.destroy();
  });

  test('the receiver rejects a file that ends short', async () => {
    const sender = await fakeSender('200003', [{ id: 'a', name: 'x.bin', size: 10 }], (conn, { req }) => {
      conn.send(JSON.stringify({ type: 'start', req }));
      conn.send(new Uint8Array(4).buffer);
      conn.send(JSON.stringify({ type: 'end', req }));
    });
    const found = await connect('200003');
    await expect(found.save(found.files[0])).rejects.toMatchObject({ kind: 'failed', message: 'The file arrived incomplete.' });
    sender.destroy();
  });

  test('data sent before the sender confirms the request is ignored', async () => {
    const sender = await fakeSender('200004', [{ id: 'a', name: 'x.bin', size: 3 }], (conn, { req }) => {
      conn.send(new Uint8Array([9, 9, 9]).buffer);
      conn.send(JSON.stringify({ type: 'start', req }));
      conn.send(new Uint8Array([1, 2, 3]).buffer);
      conn.send(JSON.stringify({ type: 'end', req }));
    });
    const found = await connect('200004');
    await found.save(found.files[0]);
    expect([...sinks[0].bytes()]).toEqual([1, 2, 3]);
    sender.destroy();
  });

  test('a sender that goes silent mid-file is treated as lost', async () => {
    const sender = await fakeSender('200005', [{ id: 'a', name: 'x.bin', size: 100 }], (conn, { req }) => {
      conn.send(JSON.stringify({ type: 'start', req }));
      conn.send(new Uint8Array(10).buffer);
    });
    const onLost = vi.fn();
    const found = await connect('200005', { onLost });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const saving = found.save(found.files[0]).catch((e) => e);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await saving).kind).toBe('lost');
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(sinks[0].aborted).toBe(true); // the stuck download is stopped
    } finally {
      vi.useRealTimers();
    }
    sender.destroy();
  });
});
