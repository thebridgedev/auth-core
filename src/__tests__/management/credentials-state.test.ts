/**
 * TBP-663 — `CredentialsState` must match what bridge-api actually returns.
 * The old type declared `hasStripeCredentials`, which the API never sent, so
 * every reader got `undefined`. This pins the server's field names: if the
 * type drifts from them again, the `satisfies` below stops compiling
 * (`bun run build` / tsc) and the runtime assertion fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { AppManagementService } from '../../management/app.service.js';
import type { CredentialsState } from '../../management-types.js';

/** Verbatim shape of bridge-api's GetCredentialsStateResponseDto. */
const SERVER_RESPONSE = {
  stripeCredentialsAdded: true,
  stripeWebhookConfigured: false,
  azureMarketplaceCredentialsAdded: false,
  azureAdSsoCredentialsAdded: false,
  googleSsoCredentialsAdded: true,
  linkedinSsoCredentialsAdded: false,
  appleSsoCredentialsAdded: false,
  githubSsoCredentialsAdded: false,
  facebookSsoCredentialsAdded: false,
} satisfies CredentialsState;

describe('CredentialsState (TBP-663)', () => {
  it('reads the server field names through the management client', async () => {
    const http = { get: vi.fn().mockResolvedValue(SERVER_RESPONSE) };
    const app = new AppManagementService(http as never);
    const state = await app.getCredentialsState();
    expect(state.stripeCredentialsAdded).toBe(true);
    expect(state.googleSsoCredentialsAdded).toBe(true);
    expect(http.get).toHaveBeenCalledWith('/v1/account/app/credentialsState');
  });

  it('does not declare the fields the API never returned', () => {
    // @ts-expect-error — removed: the API never sent it (TBP-656 / TBP-663)
    const legacy: CredentialsState['hasStripeCredentials'] = undefined;
    expect(legacy).toBeUndefined();
  });
});
