// An error with an HTTP status. `extra` is merged into the JSON error body.
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError(400, message);
