// Billing 2.0 / Phase B — pure derivation helpers in `src/billing/types.ts`.
//
// `deriveNoticeState(state)` maps a canonical `BillingSubscriptionState` to
// one of 10 UI states the `<BridgeBillingNotice />` component renders.
// `deriveSeverity(noticeState)` maps each UI state to a severity token used
// for badge / banner styling.
//
// Pure functions, no I/O. We exercise every branch.

import { describe, it, expect } from 'vitest';
import {
  deriveNoticeState,
  deriveSeverity,
} from '../billing/types.js';
import type {
  BillingNoticeState,
  BillingSubscriptionState,
} from '../billing/types.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PLAN = { slug: 'pro', name: 'Pro' };

function makeState(
  overrides: Partial<BillingSubscriptionState> = {},
): BillingSubscriptionState {
  return {
    plan: PLAN,
    status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveNoticeState
// ---------------------------------------------------------------------------

describe('deriveNoticeState(state)', () => {
  it('null state → "active" (default for unmounted SDK)', () => {
    expect(deriveNoticeState(null)).toBe('active');
  });

  it('gateEngaged=true short-circuits to "dunning_exhausted" regardless of status', () => {
    // gateEngaged is the highest-priority signal — it overrides every other
    // status branch because the workspace is locked.
    expect(deriveNoticeState(makeState({ gateEngaged: true }))).toBe(
      'dunning_exhausted',
    );
    expect(
      deriveNoticeState(makeState({ status: 'active', gateEngaged: true })),
    ).toBe('dunning_exhausted');
    expect(
      deriveNoticeState(makeState({ status: 'trial', gateEngaged: true })),
    ).toBe('dunning_exhausted');
  });

  it('status="canceled" → "canceled"', () => {
    expect(deriveNoticeState(makeState({ status: 'canceled' }))).toBe('canceled');
  });

  it('status="cancel_at_period_end" → "cancel_at_period_end"', () => {
    expect(
      deriveNoticeState(makeState({ status: 'cancel_at_period_end' })),
    ).toBe('cancel_at_period_end');
  });

  describe('status="past_due"', () => {
    it('pastDueReason="trial_expired" → "past_due_trial"', () => {
      expect(
        deriveNoticeState(
          makeState({ status: 'past_due', pastDueReason: 'trial_expired' }),
        ),
      ).toBe('past_due_trial');
    });

    it('finalRetryAt present → "dunning_final_retry"', () => {
      expect(
        deriveNoticeState(
          makeState({
            status: 'past_due',
            finalRetryAt: '2026-05-25T00:00:00.000Z',
          }),
        ),
      ).toBe('dunning_final_retry');
    });

    it('nextRetryAt present (no finalRetryAt) → "dunning_active"', () => {
      expect(
        deriveNoticeState(
          makeState({
            status: 'past_due',
            nextRetryAt: '2026-05-20T00:00:00.000Z',
          }),
        ),
      ).toBe('dunning_active');
    });

    it('no retry metadata → plain "past_due"', () => {
      expect(deriveNoticeState(makeState({ status: 'past_due' }))).toBe('past_due');
    });

    it('finalRetryAt takes precedence over nextRetryAt', () => {
      expect(
        deriveNoticeState(
          makeState({
            status: 'past_due',
            nextRetryAt: '2026-05-20T00:00:00.000Z',
            finalRetryAt: '2026-05-25T00:00:00.000Z',
          }),
        ),
      ).toBe('dunning_final_retry');
    });

    it('trial_expired wins over retry metadata', () => {
      expect(
        deriveNoticeState(
          makeState({
            status: 'past_due',
            pastDueReason: 'trial_expired',
            nextRetryAt: '2026-05-20T00:00:00.000Z',
            finalRetryAt: '2026-05-25T00:00:00.000Z',
          }),
        ),
      ).toBe('past_due_trial');
    });
  });

  describe('status="trial"', () => {
    it('daysLeft <= 3 → "trial_ending_soon"', () => {
      expect(
        deriveNoticeState(makeState({ status: 'trial', daysLeft: 3 })),
      ).toBe('trial_ending_soon');
      expect(
        deriveNoticeState(makeState({ status: 'trial', daysLeft: 0 })),
      ).toBe('trial_ending_soon');
    });

    it('daysLeft > 3 → "trial_active"', () => {
      expect(
        deriveNoticeState(makeState({ status: 'trial', daysLeft: 14 })),
      ).toBe('trial_active');
    });

    it('daysLeft undefined → "trial_active" (no warning)', () => {
      expect(deriveNoticeState(makeState({ status: 'trial' }))).toBe('trial_active');
    });
  });

  it('status="active" → "active"', () => {
    expect(deriveNoticeState(makeState({ status: 'active' }))).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// deriveSeverity — the static map from notice state → severity token.
// ---------------------------------------------------------------------------

describe('deriveSeverity(noticeState)', () => {
  const cases: Array<[BillingNoticeState, ReturnType<typeof deriveSeverity>]> = [
    ['active', 'info'],
    ['trial_active', 'info'],
    ['trial_ending_soon', 'warn'],
    ['cancel_at_period_end', 'info'],
    ['canceled', 'warn'],
    ['past_due', 'warn'],
    ['past_due_trial', 'warn'],
    ['dunning_active', 'warn'],
    ['dunning_final_retry', 'critical'],
    ['dunning_exhausted', 'locked'],
  ];

  for (const [noticeState, expected] of cases) {
    it(`"${noticeState}" → "${expected}"`, () => {
      expect(deriveSeverity(noticeState)).toBe(expected);
    });
  }
});
