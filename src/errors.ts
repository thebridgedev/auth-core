export class BridgeAuthError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BridgeAuthError';
  }
}

export class HttpError extends BridgeAuthError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message, `HTTP_${status}`);
    this.name = 'HttpError';
  }
}
