import { describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../../core/errors.js';
import { renewing, RENEW_WAITS_MS } from '../../renewal.js';
import type { Session } from '../../session.js';

function sessionWith(refresh: () => Promise<void>, status: 'signed-in' | 'signed-out' = 'signed-in'): Session {
  return { state: { get: () => ({ status }) }, refresh: vi.fn(refresh) } as unknown as Session;
}

describe('renewing a token Bridge took back', () => {
  it('waits a few seconds in all before giving up: the first renewal is at once, the later ones wait longer each time', () => {
    expect(RENEW_WAITS_MS[0]).toBe(0);
    for (let i = 1; i < RENEW_WAITS_MS.length; i += 1) expect(RENEW_WAITS_MS[i]).toBeGreaterThan(RENEW_WAITS_MS[i - 1] as number);
    const total = RENEW_WAITS_MS.reduce((sum, wait) => sum + wait, 0);
    expect(total).toBeGreaterThan(2_000);
    expect(total).toBeLessThanOrEqual(10_000);
  });

  it('renews again while the renewed token is still refused, and goes through once it is not', async () => {
    const session = sessionWith(async () => undefined);
    let calls = 0;
    const renewed = vi.fn();
    const result = await renewing(session, async () => {
      calls += 1;
      if (calls <= 2) throw new BridgeError('signed-out', 'The token is not valid.');
      return 'ok';
    }, renewed, [0, 1, 1]);
    expect(result).toBe('ok');
    expect(session.refresh).toHaveBeenCalledTimes(2);
    expect(renewed).toHaveBeenCalledTimes(1);
  });

  it('never loops forever: after the last wait it gives up with the refusal', async () => {
    const session = sessionWith(async () => undefined);
    const work = vi.fn(async () => {
      throw new BridgeError('signed-out', 'The token is not valid.');
    });
    await expect(renewing(session, work, undefined, [0, 1, 1])).rejects.toMatchObject({ kind: 'signed-out' });
    expect(session.refresh).toHaveBeenCalledTimes(3);
    expect(work).toHaveBeenCalledTimes(4);
  });

  it('stops at once when the session cannot be renewed, and when another refusal is not a sign-out', async () => {
    const ended = sessionWith(async () => {
      throw new Error('refresh token refused');
    });
    await expect(renewing(ended, async () => {
      throw new BridgeError('signed-out', 'x');
    }, undefined, [0, 1, 1])).rejects.toMatchObject({ kind: 'signed-out' });
    expect(ended.refresh).toHaveBeenCalledTimes(1);

    const session = sessionWith(async () => undefined);
    let calls = 0;
    await expect(renewing(session, async () => {
      calls += 1;
      throw calls === 1 ? new BridgeError('signed-out', 'x') : new BridgeError('forbidden', 'y');
    }, undefined, [0, 1, 1])).rejects.toMatchObject({ kind: 'forbidden' });
    expect(session.refresh).toHaveBeenCalledTimes(1);
  });
});
