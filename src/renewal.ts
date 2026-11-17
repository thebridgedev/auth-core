import { isBridgeError } from './core/errors.js';
import type { Session } from './session.js';

/**
 * Locking a workspace for payment, or lifting the lock, takes back the tokens the people in it hold. A page that was
 * open meanwhile gets 401 on its next call. That is not a sign-out: the session renews itself with its refresh token,
 * silently, and the call is made once more.
 *
 * `work` is run; when it is refused as signed out (401) while the person is still signed in, the session is renewed
 * and `work` is run once more, then `renewed` is told (the lock may have changed: read it again). When the session
 * cannot be renewed it has ended, as any sign-out does, and the first refusal is thrown.
 */
export async function renewing<T>(session: Session, work: () => Promise<T>, renewed?: () => void): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isBridgeError(error, 'signed-out') || session.state.get().status !== 'signed-in') throw error;
    try {
      await session.refresh({ force: true });
    } catch {
      throw error;
    }
    const result = await work();
    renewed?.();
    return result;
  }
}
