/**
 * Reading the credential from a request.
 *
 * Only two headers are ever read: `Authorization: Bearer <token>` and
 * `x-api-key: <key>`. Nothing else in a request (other headers, the query
 * string, the body) can name who is calling, so nothing else is read.
 */

/** A credential as presented: a signed token, or a key. */
export type Credential =
  | { readonly type: 'token'; readonly value: string }
  | { readonly type: 'key'; readonly value: string };

/** Fetch API `Headers`, or a plain header object such as Node's `IncomingHttpHeaders`. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function header(headers: HeadersLike, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  const matches = Object.keys(record).filter((key) => key.toLowerCase() === name);
  // A header sent more than once is ambiguous: read neither copy.
  if (matches.length !== 1) return null;
  const value = record[matches[0]];
  return typeof value === 'string' ? value : null;
}

/**
 * The credentials a request carries, in the order the verifier tries them:
 * the bearer token first, then the key. At most one of each.
 */
export function readCredentials(headers: HeadersLike): Credential[] {
  const found: Credential[] = [];

  const authorization = header(headers, 'authorization');
  const bearer = authorization?.match(/^Bearer[ ]+([^ ]+)[ ]*$/i);
  if (bearer) found.push({ type: 'token', value: bearer[1] });

  const key = header(headers, 'x-api-key')?.trim();
  if (key) found.push({ type: 'key', value: key });

  return found;
}
