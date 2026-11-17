import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { storage, bucket, ensureBucket } from './storage.js';
import { createPeerServer } from './peer.js';
import { sharesRouter } from './routes/shares.js';
import { loadIndex, startSweeper } from './shares.js';

function createApp(server) {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    try {
      const bucketReady = await storage.bucketExists(bucket);
      res.status(bucketReady ? 200 : 503).json({ ok: bucketReady, storage: bucketReady ? 'up' : 'bucket missing' });
    } catch (err) {
      res.status(503).json({ ok: false, storage: 'down', error: err.code ?? err.message });
    }
  });

  app.use('/api/shares', sharesRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // PeerJS signaling for peer shares: clients connect with
  // new Peer({ host, port, path: config.peerPath }).
  app.use(config.peerPath, createPeerServer(server));

  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message, ...err.extra });
  });

  return app;
}

// Prepares storage and starts listening. Resolves with the HTTP server, the
// number of shares found in storage, and a stop() that closes the server.
// PeerServer keeps internal timers it offers no way to cancel, so the process
// still has to be exited explicitly after stop() (the tests use
// --test-force-exit for this).
export async function start({ port = config.port } = {}) {
  const server = createServer();
  server.on('request', createApp(server));

  await ensureBucket();
  const shareCount = await loadIndex();
  const sweeper = startSweeper(config.shares.sweepIntervalMs);
  await new Promise((resolve) => server.listen(port, resolve));

  const stop = () => new Promise((resolve) => {
    clearInterval(sweeper);
    server.close(resolve);
    server.closeAllConnections();
  });
  return { server, shareCount, stop };
}
