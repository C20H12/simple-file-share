const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  corsOrigin: env.CORS_ORIGIN ?? '*',
  minio: {
    endPoint: env.MINIO_ENDPOINT ?? 'localhost',
    port: Number(env.MINIO_PORT ?? 9000),
    useSSL: env.MINIO_USE_SSL === 'true',
    accessKey: env.MINIO_ROOT_USER,
    secretKey: env.MINIO_ROOT_PASSWORD,
    bucket: env.MINIO_BUCKET ?? 'shares',
  },
  peerPath: env.PEER_PATH ?? '/peer',
  shares: {
    maxFiles: Number(env.MAX_SHARE_FILES ?? 100),
    maxBytes: Number(env.MAX_SHARE_BYTES ?? 50 * 1000 ** 2), // 50 MB, counted as the frontend shows sizes
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 60_000),
  },
  limits: {
    windowMs: Number(env.LIMIT_WINDOW_MS ?? 15 * 60_000),
    lookupMisses: Number(env.LOOKUP_MAX_MISSES ?? 30),
    unlockFailures: Number(env.UNLOCK_MAX_FAILURES ?? 10),
  },
  // Set when running behind a reverse proxy, so rate limits see the real
  // client address. Takes the same values as Express's "trust proxy".
  trustProxy: env.TRUST_PROXY,
};
