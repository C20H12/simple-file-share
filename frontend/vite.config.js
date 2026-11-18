import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The backend (see ../backend) serves the API and the PeerJS signaling
// endpoint; proxying keeps both same-origin. Set API_PROXY_TARGET to point the
// dev server at a backend elsewhere.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

// DEV_HTTPS=1 serves the dev server over HTTPS with a self-signed certificate
// (the browser warns once; accept it). Needed when testing from another
// machine: over plain http to anything but localhost, browsers withhold what
// password-protected shares (Web Crypto), peer share and streaming downloads
// rely on.
const https = process.env.DEV_HTTPS === '1';

// pdf.js fetches these at runtime for PDFs that rely on them: character maps
// (CJK text), the standard fonts, image decoders and colour profiles. This
// serves them from node_modules under /pdfjs/ in dev and copies them into the
// build, so they never need to be checked in.
function pdfjsAssets() {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const folders = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  const types = { '.wasm': 'application/wasm', '.js': 'text/javascript' };
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const match = /^\/([a-z_]+)\/([\w.-]+)$/.exec(req.url.split('?')[0]);
        if (!match || !folders.includes(match[1])) return next();
        const file = `${root}${match[1]}/${match[2]}`;
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        const ext = match[2].slice(match[2].lastIndexOf('.'));
        res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const folder of folders) {
        for (const name of readdirSync(root + folder)) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${name}`, source: readFileSync(`${root}${folder}/${name}`) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), ...(https ? [basicSsl()] : [])],
  server: {
    // Every IPv4 interface, so other machines on the network can connect
    // (http://<this machine's address>:5173). IPv4 rather than Vite's default
    // "localhost", which on many systems means the IPv6 loopback only, and
    // Firefox cannot set up a WebRTC connection (peer share) from a page
    // loaded over IPv6 loopback on a machine without IPv6 connectivity.
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/peer': { target: apiTarget, ws: true },
    },
  },
  // Vitest (npm test). Tests run in Node; a file that needs a DOM says so with
  // a `@vitest-environment jsdom` comment.
  test: {
    include: ['tests/**/*.test.{js,jsx}'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
