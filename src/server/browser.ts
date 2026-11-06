/**
 * What a browser build gets for `@nebulr-group/bridge-auth-core/server`.
 *
 * The server entry holds the app key, which reaches the whole app. It must
 * never be bundled into a page, so a browser build fails here, at once,
 * instead of shipping the key. Import it only from server code (hooks,
 * API routes, `+server.ts`, middleware).
 */
throw new Error(
  '@nebulr-group/bridge-auth-core/server runs only on a server: it was imported into a browser build. Import it from server code only.',
);

export {};
