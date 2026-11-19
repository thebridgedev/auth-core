import { isBridgeError } from './core/errors.js';
import { sleep } from './core/util.js';
import type { Session } from './session.js';

/**
 * How long to wait before each renewal while a renewed token is still refused. Bridge takes back the tokens issued
 * until a moment after a lock or unlock (it allows for servers' clocks running a little apart), so a token renewed at
 * once can be refused as well. The first renewal is at once; the later ones wait, a few seconds in all, then give up.
 */
export const RENEW_WAITS_MS: readonly number[] = [0, 1_000, 2_000, 4_000];

/**
 * Locking a workspace for payment, or lifting the lock, takes back the tokens the people in it hold. A page that was
 * open meanwhile gets 401 on its next call. That is not a sign-out: the session renews itself with its refresh token,
 * silently, and the call is made once more.
 *
 * `work` is run; when it is refused as signed out (401) while the person is still signed in, the session is renewed
 * and `work` is run once more, then `renewed` is told (the lock may have changed: read it again). While the renewed
 * token is refused too (it was issued inside the moment Bridge still takes back), it waits a little longer and renews
 * again, as `waits` says, then gives up with the last refusal. When the session cannot be renewed it has ended, as any
 * sign-out does, and the first refusal is thrown.
 */
export async function renewing<T>(session: Session, work: () => Promise<T>, renewed?: () => void, waits: readonly number[] = RENEW_WAITS_MS): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isBridgeError(error, 'signed-out') || session.state.get().status !== 'signed-in') throw error;
    let refused: unknown = error;
    for (const wait of waits) {
      if (wait > 0) await sleep(wait);
      if (session.state.get().status !== 'signed-in') throw refused;
      try {
        await session.refresh({ force: true });
      } catch {
        throw error;
      }
      try {
        const result = await work();
        renewed?.();
        return result;
      } catch (again) {
        if (!isBridgeError(again, 'signed-out')) throw again;
        refused = again;
      }
    }
    throw refused;
  }
}
