import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { startTestServer } from './helpers.js';

// Peer shares send files browser to browser; the server's part is PeerJS
// signaling under /peer. These tests speak that protocol directly.
let app;
const sockets = [];
before(async () => { app = await startTestServer(); });
after(async () => {
  for (const socket of sockets) socket.terminate();
  await app.close();
});

const issueId = async () => (await fetch(`${app.url}/peer/peerjs/id`)).text();

// Registers a peer and resolves with { socket, next } once the server accepts
// it. next() resolves with the next message the server sends this peer.
function join(id, token = randomUUID()) {
  const socket = new WebSocket(`${app.url.replace('http', 'ws')}/peer/peerjs?key=peerjs&id=${id}&token=${token}`);
  sockets.push(socket);
  const inbox = [];
  const waiting = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (waiting.length) waiting.shift()(message);
    else inbox.push(message);
  });
  const next = (timeoutMs = 8000) => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const timer = setTimeout(() => reject(new Error('no message from the signaling server')), timeoutMs);
    waiting.push((message) => { clearTimeout(timer); resolve(message); });
  });
  return new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('open', () => resolve({ socket, next, send: (message) => socket.send(JSON.stringify(message)) }));
  });
}

describe('peer signaling', () => {
  test('issues 6-digit ids, which serve as share codes', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, issueId));
    for (const id of ids) assert.match(id, /^\d{6}$/);
    assert.ok(new Set(ids).size > 1);
  });

  test('accepts a sender under an issued code', async () => {
    const sender = await join(await issueId());
    assert.equal((await sender.next()).type, 'OPEN');
  });

  test('never issues a code that a connected sender holds', async () => {
    const code = await issueId();
    const sender = await join(code);
    await sender.next();
    const later = await Promise.all(Array.from({ length: 50 }, issueId));
    assert.ok(!later.includes(code));
  });

  test('passes connection offers and answers between receiver and sender', async () => {
    const code = await issueId();
    const sender = await join(code);
    await sender.next();
    const receiverId = randomUUID();
    const receiver = await join(receiverId);
    await receiver.next();

    receiver.send({ type: 'OFFER', dst: code, payload: { sdp: 'offer-sdp', connectionId: 'dc_1' } });
    assert.deepEqual(await sender.next(), { type: 'OFFER', src: receiverId, dst: code, payload: { sdp: 'offer-sdp', connectionId: 'dc_1' } });

    sender.send({ type: 'ANSWER', dst: receiverId, payload: { sdp: 'answer-sdp', connectionId: 'dc_1' } });
    assert.deepEqual(await receiver.next(), { type: 'ANSWER', src: code, dst: receiverId, payload: { sdp: 'answer-sdp', connectionId: 'dc_1' } });
  });

  test('tells a receiver when nobody is hosting the code', async () => {
    const receiver = await join(randomUUID());
    await receiver.next();
    receiver.send({ type: 'OFFER', dst: '000000', payload: { sdp: 'offer-sdp' } });
    const reply = await receiver.next();
    assert.equal(reply.type, 'EXPIRE');
    assert.equal(reply.src, '000000');
  });

  test('refuses a second peer trying to take a code that is in use', async () => {
    const code = await issueId();
    const sender = await join(code);
    await sender.next();
    const impostor = await join(code);
    assert.equal((await impostor.next()).type, 'ID-TAKEN');
  });

  test('does not list connected peers', async () => {
    const sender = await join(await issueId());
    await sender.next();
    assert.equal((await fetch(`${app.url}/peer/peerjs/peers`)).status, 401);
  });
});
