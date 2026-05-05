const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function getTokenExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return null;
  return (payload.exp as number) * 1000;
}

export function shouldRefreshNow(accessToken: string | null): boolean {
  if (!accessToken) return false;
  const exp = getTokenExpiry(accessToken);
  if (!exp) return false;
  return exp - Date.now() <= REFRESH_THRESHOLD_MS;
}

export function isTokenExpired(token: string): boolean {
  const exp = getTokenExpiry(token);
  if (!exp) return true;
  return Date.now() >= exp;
}

/** Read the `tid` (tenant) claim from a Bridge access token. Null if missing/malformed. */
export function getTenantId(token: string): string | null {
  const p = decodeJwtPayload(token);
  return p && typeof p.tid === 'string' ? p.tid : null;
}

/** Read the `sub` (tenantUser) claim. Bridge access tokens use `sub` as the tenantUserId. */
export function getTenantUserId(token: string): string | null {
  const p = decodeJwtPayload(token);
  return p && typeof p.sub === 'string' ? p.sub : null;
}

export { REFRESH_THRESHOLD_MS };
