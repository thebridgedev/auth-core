/**
 * TBP-722 — the platform `fetch`, safe to store on an object and call as a
 * method.
 *
 * A browser's native `fetch` must be invoked with `this` set to the Window (or
 * undefined). Stored as `cfg.fetchFn = fetch` and called as
 * `this.cfg.fetchFn(url)`, it runs with `this === cfg` and Chrome throws
 * `TypeError: Illegal invocation`. That silently disabled live updates and
 * browser usage reporting in every SDK that did not replace `globalThis.fetch`
 * itself (react, nextjs, angular) from 0.4.0 until this fix.
 *
 * The function is captured NOW, exactly as the old `?? fetch` default did, so
 * which `fetch` a client uses is unchanged (bridge-svelte's later auth wrapper
 * still does not reach clients built before it). Only the binding is fixed.
 * Returns `undefined` where no `fetch` exists, which callers already expect.
 */
export function defaultFetch(): typeof fetch {
  if (typeof fetch === 'undefined') return undefined as unknown as typeof fetch;
  const platformFetch = fetch;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    platformFetch.call(globalThis, input, init)) as typeof fetch;
}
