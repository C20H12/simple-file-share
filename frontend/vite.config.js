import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend (see ../backend) serves the API; proxying keeps it same-origin.
// Set API_PROXY_TARGET to point the dev server at a backend elsewhere.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

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
  plugins: [react(), pdfjsAssets()],
  server: {
    port: 5173,
    proxy: { '/api': apiTarget },
  },
});
