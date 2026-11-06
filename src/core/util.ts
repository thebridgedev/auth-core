/**
 * Small pieces the rest of the SDK shares: PKCE, base64url, reading a JWT's
 * payload, random ids and an event emitter. Web Crypto only, so they run in
 * browsers, Node and edge runtimes alike.
 */

function webCrypto(): Crypto {
  const found = (globalThis as { crypto?: Crypto }).crypto;
  if (found?.subtle === undefined || typeof found.getRandomValues !== 'function') {
    throw new Error('Web Crypto is not available in this runtime; the SDK needs it for PKCE and ids.');
  }
  return found;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlText(value: string): string {
  return base64url(new TextEncoder().encode(value));
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(bytes = 32): string {
  return base64url(webCrypto().getRandomValues(new Uint8Array(bytes)));
}

export function randomId(): string {
  const crypto = webCrypto();
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : randomToken(16);
}

/** A PKCE pair (RFC 7636, S256): the verifier stays on this device, the challenge goes to Bridge. */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await webCrypto().subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** An S256 challenge: 43 base64url characters. */
export function isS256Challenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * A JWT's payload, read without checking its signature. The SDK uses it only
 * on tokens it just received from the token endpoint over TLS, to show who is
 * signed in; it never decides access on it. Servers check tokens with the
 * verifier.
 */
export function readJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type Listener<T> = (value: T) => void;

/** A typed event emitter. A listener that throws never stops the others. */
export class Emitter<Events extends { [name: string]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(name: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(name: K, value: Events[K]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try {
        (listener as Listener<Events[K]>)(value);
      } catch (error) {
        if (name !== 'error') this.emit('error' as K, error as Events[K]);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** A value that can be read now and watched. */
export interface Readable<T> {
  get(): T;
  /** Calls `listener` now and on every change. Returns the way to stop. */
  subscribe(listener: Listener<T>): () => void;
}

export class Store<T> implements Readable<T> {
  private readonly listeners = new Set<Listener<T>>();
  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A listener's own error is its own.
      }
    }
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
