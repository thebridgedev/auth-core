/**
 * Marketing attribution carried on sign-in and sign-up URLs (TBP-474,
 * TBP-746, TBP-894).
 *
 * A visitor who arrives tagged (utm_*, a click id, `ref` from a short link)
 * must keep those tags across every hop to the workspace record, without
 * device storage: tags in the URL and in page memory need no consent, a
 * cookie does. This module is the one list of what is carried and the one
 * helper that carries it, for every Bridge front end.
 *
 * `ref` is the content code of a short link (CODE8). Never `code`: that is
 * the OAuth authorization code on the same routes.
 */
export const ATTRIBUTION_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'rdt_cid',
  'gclid',
  'fbclid',
  'li_fat_id',
  'ref',
  'landing_path',
  'referrer_host',
  'capture',
] as const;

export type AttributionParam = (typeof ATTRIBUTION_PARAMS)[number];

/** Longest value carried. Same cap as the API applies. */
const MAX_VALUE_LENGTH = 512;

/** The attribution params of a query string (`?utm_source=…`), allowlisted and capped. */
export function readAttributionParams(search: string | URLSearchParams | undefined): Partial<Record<AttributionParam, string>> {
  const params = typeof search === 'string' || search === undefined ? new URLSearchParams(search ?? '') : search;
  const out: Partial<Record<AttributionParam, string>> = {};
  for (const key of ATTRIBUTION_PARAMS) {
    const value = params.get(key);
    if (value && value.length <= MAX_VALUE_LENGTH) out[key] = value;
  }
  return out;
}

/**
 * Copy the attribution params of `search` (default: the current page's) onto
 * `url`. Params the URL already has win: an explicit link is more specific.
 * Returns the URL unchanged when there is nothing to carry.
 */
export function carryAttribution(url: string, search?: string): string {
  const source =
    search ?? (typeof window !== 'undefined' && window.location ? window.location.search ?? '' : '');
  const carried = readAttributionParams(source);
  const keys = Object.keys(carried) as AttributionParam[];
  if (keys.length === 0) return url;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const target = new URL(url, 'https://relative.invalid');
  for (const key of keys) {
    if (!target.searchParams.has(key)) target.searchParams.set(key, carried[key] as string);
  }
  return absolute ? target.toString() : `${target.pathname}${target.search}${target.hash}`;
}
