export interface Logger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(debug: boolean): Logger {
  return {
    debug(...args: unknown[]) {
      if (debug) console.debug('[bridge-auth]', ...args);
    },
    warn(...args: unknown[]) {
      if (debug) console.warn('[bridge-auth]', ...args);
    },
    error(...args: unknown[]) {
      console.error('[bridge-auth]', ...args);
    },
  };
}
