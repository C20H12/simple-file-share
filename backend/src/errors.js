// An error with an HTTP status. `extra` is merged into the JSON error body.
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError(400, message);

// The server cannot take more data: the share budget is used up, or storage
// itself refused a write. 507 is "Insufficient Storage".
export const storageFull = () => new HttpError(507, 'the server is out of storage space; try again later', { reason: 'storage-full' });

// Error codes MinIO uses when a write is refused for lack of space or quota.
const STORAGE_FULL_CODES = new Set(['XMinioStorageFull', 'XMinioAdminBucketQuotaExceeded', 'XMinioBucketQuotaExceeded', 'QuotaExceeded']);
export const isStorageFull = (err) => STORAGE_FULL_CODES.has(err?.code);
