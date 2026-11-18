// An in-memory stand-in for the parts of PeerJS that src/lib/peer.js uses.
// Peers in one test "network" find each other by id, and a connection
// delivers what one side sends to the other, in order, asynchronously (the
// way a data channel does). Binary data is copied on the way, like a real
// channel, so neither side shares buffers with the other.
//
// `network` lets a test watch and interfere:
//   network.onSend(conn, data)  called for everything sent, before delivery;
//                               closing the connection here drops the data
//   network.peers               registered peers by id
//   network.created             every Peer constructed, in order
//   network.connections         every connection end ever opened, in order

class Emitter {
  #handlers = new Map();
  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(fn);
    return this;
  }
  once(event, fn) {
    const wrapped = (...args) => { this.off(event, wrapped); fn(...args); };
    return this.on(event, wrapped);
  }
  off(event, fn) {
    this.#handlers.set(event, (this.#handlers.get(event) ?? []).filter((h) => h !== fn));
    return this;
  }
  emit(event, ...args) {
    for (const fn of [...(this.#handlers.get(event) ?? [])]) fn(...args);
  }
}

const decode = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const network = {
  peers: new Map(),
  created: [],
  connections: [],
  nextCode: 100000,
  onSend: null,
  reset() {
    this.peers.clear();
    this.created = [];
    this.connections = [];
    this.nextCode = 100000;
    this.onSend = null;
  },
};

export class DataConnection extends Emitter {
  constructor(peer, remoteId, side) {
    super();
    this.peer = peer.id;
    this.owner = peer;
    this.remoteId = remoteId;
    this.side = side; // 'receiver' or 'sender', for tests
    this.open = false;
    this.closed = false;
    this.other = null;
    this.sent = []; // everything this side sent: JSON decoded, other text as is, binary as a byte count
    network.connections.push(this);
  }

  send(data) {
    if (!this.open) return;
    const copy = typeof data === 'string' ? data : data.slice(0);
    this.sent.push(typeof data === 'string' ? decode(data) : copy.byteLength);
    network.onSend?.(this, copy);
    const target = this.other;
    queueMicrotask(() => { if (this.open && target.open) target.emit('data', copy); });
  }

  close() {
    for (const side of [this, this.other]) {
      if (!side || side.closed) continue;
      side.closed = true;
      side.open = false;
      side.owner.connections.delete(side);
      queueMicrotask(() => side.emit('close'));
    }
  }
}

export class Peer extends Emitter {
  constructor(id, options) {
    super();
    if (typeof id !== 'string') {
      options = id;
      id = String(network.nextCode++); // the server issues ids, which are share codes
    }
    this.id = id;
    this.options = options;
    this.destroyed = false;
    this.disconnected = false;
    this.connections = new Set();
    network.created.push(this);
    queueMicrotask(() => {
      if (this.destroyed) return;
      network.peers.set(id, this);
      this.emit('open', id);
    });
  }

  connect(remoteId) {
    const local = new DataConnection(this, remoteId, 'receiver');
    this.connections.add(local);
    queueMicrotask(() => {
      const host = network.peers.get(remoteId);
      if (!host || host.destroyed) {
        this.emit('error', Object.assign(new Error(`Could not connect to peer ${remoteId}`), { type: 'peer-unavailable' }));
        return;
      }
      const remote = new DataConnection(host, this.id, 'sender');
      local.other = remote;
      remote.other = local;
      host.connections.add(remote);
      host.emit('connection', remote);
      queueMicrotask(() => {
        if (local.closed || remote.closed) return;
        local.open = true;
        remote.open = true;
        remote.emit('open');
        local.emit('open');
      });
    });
    return local;
  }

  reconnect() {
    this.disconnected = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (network.peers.get(this.id) === this) network.peers.delete(this.id);
    for (const conn of [...this.connections]) conn.close();
  }
}

export default Peer;
