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
    maxBytes: Number(env.MAX_SHARE_BYTES ?? 2 * 1024 ** 3),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 60_000),
  },
};
