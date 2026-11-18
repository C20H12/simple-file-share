# Handoff — simple file share

A small web app for handing files to someone else, two ways:

- **Upload** — up to 50 MB per share. Files are stored on the server under a
  6-digit code and a link (with a QR code), and expire after the first
  download (the default), after 1 hour to 7 days, or on a chosen date. The
  server holds at most 3 GB of shares in total; when that is used up, new
  uploads are refused with a "storage full" message until space frees up. An optional password encrypts the files in the
  sender's browser before upload (AES-256-GCM, key derived with PBKDF2); the
  server only ever holds ciphertext and a hash of a password verifier.
- **Peer share** — no size limit. Files go straight from the sender's browser
  to the receiver's over WebRTC. Nothing is stored on the server, which only
  introduces the two browsers. The sender keeps the page open; interrupted
  transfers resume where they stopped.

Receivers open the link or type the code. Images and PDFs of uploaded shares
can be previewed (PDFs via pdf.js, up to 25 MB); everything else downloads.
Plain files download straight from the server, while files the page has to
produce itself (decrypted or received from a peer) are streamed to disk
through a service worker, so large files never sit in browser memory. The home
page lists recently sent and received codes, kept in the browser only.

## Tech stack

| Part | Built with |
|---|---|
| Frontend | React 19, Vite, pdf.js, PeerJS client, Web Crypto, a service worker for streamed downloads |
| Backend | Node.js 20+, Express 5, PeerJS `PeerServer` for signaling |
| Storage | MinIO (S3-compatible), run with Docker Compose; no database |
| Tests | `node:test` (backend, against a real MinIO), Vitest + jsdom + Testing Library (frontend) |

## Project structure

```
.
├── .github/workflows/build.yml  CI: tests and builds every push, deploys main
├── backend/                     Express API, PeerJS signaling and MinIO storage
│   ├── docker-compose.yml       MinIO service (S3 API on :9000, console on :9001)
│   ├── .env.example             configuration; copy to .env
│   ├── src/
│   │   ├── index.js             entry point
│   │   ├── app.js               Express app: routes, PeerServer, error handling
│   │   ├── config.js            settings read from the environment
│   │   ├── storage.js           MinIO client and bucket setup
│   │   ├── shares.js            share records, codes, expiry sweeper, one-time downloads
│   │   ├── password.js          scrypt hashing of password verifiers
│   │   ├── access.js            signed, short-lived access tokens for protected shares
│   │   ├── limits.js            rate limits for code lookups and wrong passwords
│   │   ├── peer.js              PeerServer issuing 6-digit share codes
│   │   ├── errors.js            HTTP error helpers
│   │   └── routes/
│   │       ├── upload.js        create a share, upload files, progress, complete
│   │       ├── receive.js       look up, unlock and download a share
│   │       └── common.js        shared request helpers
│   └── tests/                   API, expiry, rate-limit and signaling tests
│
└── frontend/                    React single-page app
    ├── index.html
    ├── vite.config.js           dev server, API/signaling proxy, pdf.js assets, Vitest config
    ├── .env.example             optional settings (API URL, ICE servers, debug)
    ├── public/
    │   ├── icons/               SVG icons
    │   └── stream/sw.js         service worker that streams page-made downloads to disk
    ├── src/
    │   ├── main.jsx, App.jsx    entry point and top-level routing
    │   ├── pages/
    │   │   ├── HomePage.jsx     send (upload / peer share), receive by code, recent shares
    │   │   └── ReceivePage.jsx  uploaded and peer shares: password, file list, downloads
    │   ├── components/          dialogs, file rows, previews, code input, …
    │   ├── lib/
    │   │   ├── api.js           backend API client
    │   │   ├── upload.js        upload flow, with encryption when a password is set
    │   │   ├── crypto.js        key derivation and chunked AES-GCM
    │   │   ├── download.js      fetching, decrypting and saving files
    │   │   ├── fileSink.js      writing a download to disk through the service worker
    │   │   ├── peer.js          peer share: hosting files and receiving them over WebRTC
    │   │   ├── useDownloads.js  download state for a file list
    │   │   ├── recents.js       recently sent/received codes in localStorage
    │   │   ├── router.js        minimal History API router
    │   │   └── format.js, useCopied.js
    │   └── styles/              design system (modernist.css) and app styles
    └── tests/                   unit tests; peer share runs against tests/fakePeerjs.js
```

## Running locally

Requirements: Node.js 20 or later, npm, and Docker.

```sh
# Backend: storage, then the API
cd backend
cp .env.example .env        # set MINIO_ROOT_PASSWORD to something of your own
npm install
npm run minio:up            # starts MinIO in Docker
npm run dev                 # API and signaling on http://localhost:3000

# Frontend, in a second terminal
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

The Vite dev server forwards `/api` and `/peer` to the backend, so the app is
same-origin in development. Stop MinIO with `npm run minio:down`.

## Tests

```sh
cd backend && npm test      # needs MinIO running; uses a throwaway bucket
cd frontend && npm test
```

## Production build

```sh
cd frontend && npm run build    # static files in frontend/dist
cd backend && npm ci --omit=dev && npm start
```

The backend has no build step. Serve `frontend/dist` from any web server that

- forwards `/api` and `/peer` to the backend (`/peer` uses WebSockets, so allow
  the upgrade),
- answers unknown paths with `index.html`, so share links open the app, and
- uses HTTPS: off localhost, browsers only allow Web Crypto, service workers
  and the clipboard on secure pages, and password-protected shares, peer share
  and streamed downloads depend on them.

Behind a reverse proxy, set `TRUST_PROXY` in the backend's `.env` so rate
limits see real client addresses.

Storage is capped twice: the backend refuses new shares once they would take
more than `STORAGE_MAX_BYTES` (3 GB), and `npm run minio:quota` (in
`backend/`) sets a hard quota of `MINIO_BUCKET_QUOTA` (3.5 GB) on the MinIO
bucket as a backstop. Keep both below the disk's free space.

## Deployment

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs both test
suites and builds the frontend on every push and pull request. Pushes to
`main` that pass are deployed over SSH: the build is copied to
`/srv/handoff/frontend/dist`, and the backend checkout in `/srv/handoff` is
pulled, its dependencies reinstalled and its systemd service (`handoff`)
restarted. On the server, Caddy serves the build, forwards `/api` and `/peer`
to the backend and provides HTTPS; MinIO runs in Docker. The deploy needs the
repository secrets `DEPLOY_KEY`, `DEPLOY_HOST`, `DEPLOY_USER` and
`DEPLOY_KNOWN_HOSTS`, and is skipped until they are set.
