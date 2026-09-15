/**
 * TBP-663 — auth-core management client ↔ bridge-api CONTRACT.
 *
 * `workflows.setupSSO` and `workflows.setupCommunication` failed with a 400 on
 * every real call (fields the API does not declare, rejected by its global
 * ValidationPipe: whitelist + forbidNonWhitelisted), while their unit tests
 * stayed green: the tests mocked the app service and asserted the workflows'
 * own wrong field names back.
 *
 * Here the REAL `BridgeManagement` client runs; only its HTTP transport is
 * replaced by a stand-in for bridge-api that
 *   - rejects (400) any body field the server's request class does not
 *     declare, exactly like forbidNonWhitelisted, and records it;
 *   - answers with objects shaped like the server's response classes and
 *     records any read of a field they do not declare;
 *   - records any call to a route the server does not serve.
 *
 * The field lists below are copied from bridge-api `origin/stage` @ 01a08b0;
 * each names its source class. bridge-api's own MCP contract spec
 * (microservices/account/nebulr-api/mcp/tools/__tests__/contract.spec.ts)
 * runs the published auth-core client against the real classes, so a drift
 * on either side is caught there too.
 */
import { describe, expect, it } from 'vitest';
import { BridgeManagement } from '../../management/index.js';
import { HttpError } from '../../errors.js';

// ── Server request classes (declared fields) ────────────────────────────────

/** microservices/account/nebulr-api/app/dto/update-credentials-request.dto.ts — UpdateCredentialsRequestDto */
const UPDATE_CREDENTIALS_FIELDS = [
  'stripeSecretKey', 'stripePublicKey',
  'microsoftAzureMarketplaceClientId', 'microsoftAzureMarketplaceClientSecret', 'microsoftAzureMarketplaceTenantId',
  'googleClientId', 'googleClientSecret', 'linkedinClientId', 'linkedinClientSecret',
  'githubClientId', 'githubClientSecret', 'facebookClientId', 'facebookClientSecret',
  'microsoftAzureADClientId', 'microsoftAzureADClientSecret', 'microsoftAzureADTenantId',
  'appleClientId', 'appleTeamId', 'appleKeyId', 'applePrivateKey',
];

/** microservices/account/nebulr-api/app/dto/update-app-request.dto.ts — UpdateAppRequestDto */
const UPDATE_APP_FIELDS = [
  'name', 'apiUrl', 'uiUrl', 'webhookUrl', 'webhookEventFilter', 'webhookEnabled', 'logo', 'tenantSelfSignup',
  'redirectUris', 'allowedOrigins', 'defaultCallbackUri', 'onboardingFlow', 'websiteUrl', 'privacyPolicyUrl',
  'termsOfServiceUrl', 'emailSenderName', 'emailSenderEmail', 'paymentsAutoRedirect', 'passkeysEnabled',
  'stripeEnabled', 'currency', 'mfaEnabled', 'magicLinkEnabled', 'googleSsoEnabled', 'linkedinSsoEnabled',
  'azureAdSsoEnabled', 'appleSsoEnabled', 'githubSsoEnabled', 'facebookSsoEnabled', 'azureMarketplaceEnabled',
  'accessTokenTTL', 'refreshTokenTTL', 'allowedTokenPrivileges',
];

/** microservices/account/nebulr-api/app/payments/dto/create-plan.request.ts — CreatePlanRequest */
const CREATE_PLAN_FIELDS = ['key', 'name', 'description', 'trial', 'trialDays', 'prices', 'quotas'];
/** microservices/account/nebulr-api/app/payments/dto/price.ts — Price */
const PRICE_FIELDS = ['amount', 'currency', 'recurrenceInterval'];

// ── Server response classes (every declared field present) ──────────────────

/** microservices/account/nebulr-api/app/dto/get-app-response.dto.ts — GetAppResponseDto */
const APP_RESPONSE = {
  id: 'app_1', name: 'Acme App', domain: 'ACME', apiUrl: 'https://api.acme.test', uiUrl: 'https://acme.test',
  logo: '', websiteUrl: 'https://acme.test', webhookUrl: '', privacyPolicyUrl: '', termsOfServiceUrl: '',
  emailSenderName: 'Acme', emailSenderEmail: 'no-reply@acme.test', paymentsAutoRedirect: false,
  stripeEnabled: true, stripeSetupStatus: 'completed', stripeSetupError: null, stripeLastWebhookAt: null,
  stripeLastWebhookRejectedAt: null, stripeLastWebhookRejectionReason: null, stripeWebhookRejectionStreak: 0,
  allowedTokenPrivileges: null, passkeysEnabled: true, mfaEnabled: false, magicLinkEnabled: true,
  googleSsoEnabled: false, linkedinSsoEnabled: false, azureAdSsoEnabled: false, azureMarketplaceEnabled: false,
  appleSsoEnabled: false, githubSsoEnabled: false, facebookSsoEnabled: false, onboardingFlow: 'B2B',
  tenantSelfSignup: true, redirectUris: [], allowedOrigins: [], defaultCallbackUri: 'https://auth.acme.test/cb',
  accessTokenTTL: 3600, refreshTokenTTL: 604800,
};

/** microservices/account/nebulr-api/app/dto/get-credentials-state-response.dto.ts — GetCredentialsStateResponseDto */
const CREDENTIALS_STATE_RESPONSE = {
  stripeCredentialsAdded: true, stripeWebhookConfigured: true, azureMarketplaceCredentialsAdded: false,
  azureAdSsoCredentialsAdded: false, googleSsoCredentialsAdded: false, linkedinSsoCredentialsAdded: false,
  appleSsoCredentialsAdded: false, githubSsoCredentialsAdded: false, facebookSsoCredentialsAdded: false,
};

/** microservices/account/nebulr-api/app/payments/dto/plan-response.ts — PlanResponse */
const PLAN_RESPONSE = {
  id: 'plan_1', key: 'pro', name: 'Pro', description: '', trial: false, trialDays: 0,
  createdAt: '2026-09-15T10:00:00.000Z', prices: [{ amount: 49, currency: 'USD', recurrenceInterval: 'month' }],
  quotas: [],
};

// ── Stand-in server ─────────────────────────────────────────────────────────

type Method = 'get' | 'post' | 'put' | 'delete';
type Body = Record<string, unknown>;

/** Keys JSON.stringify would actually send (undefined values are dropped on the wire). */
const sentKeys = (body: unknown): string[] =>
  body && typeof body === 'object'
    ? Object.entries(body as Body).filter(([, v]) => v !== undefined).map(([k]) => k)
    : [];

/** forbidNonWhitelisted: every sent field must be declared by the request class. */
const whitelist = (declared: string[]) => (body: unknown): string[] =>
  sentKeys(body)
    .filter((k) => !declared.includes(k))
    .map((k) => `property ${k} should not exist`);

interface Route {
  method: Method;
  path: string;
  check?: (body: unknown) => string[];
  respond: (body: unknown) => unknown;
}

const ROUTES: Route[] = [
  { method: 'get', path: '/v1/account/app', respond: () => ({ ...APP_RESPONSE }) },
  // The PUT answers with the updated app; echo what was sent so reads of it are real.
  {
    method: 'put',
    path: '/v1/account/app',
    check: whitelist(UPDATE_APP_FIELDS),
    respond: (body) => ({ ...APP_RESPONSE, ...(body as Body) }),
  },
  { method: 'get', path: '/v1/account/app/credentialsState', respond: () => ({ ...CREDENTIALS_STATE_RESPONSE }) },
  {
    method: 'put',
    path: '/v1/account/app/credentials',
    check: (body) => [
      ...whitelist(UPDATE_CREDENTIALS_FIELDS)(body),
      ...sentKeys(body)
        .filter((k) => typeof (body as Body)[k] !== 'string')
        .map((k) => `${k} must be a string`),
    ],
    respond: () => ({ ...CREDENTIALS_STATE_RESPONSE }),
  },
  {
    method: 'post',
    path: '/v1/account/payments/plan',
    check: (body) => {
      const problems = whitelist(CREATE_PLAN_FIELDS)(body);
      const prices = (body as Body)?.prices;
      // AppService.createPlan + @ArrayNotEmpty: a plan needs at least one price (TBP-617).
      if (!Array.isArray(prices) || prices.length === 0) problems.push('A plan needs at least one price.');
      else for (const price of prices) problems.push(...whitelist(PRICE_FIELDS)(price).map((p) => `prices.${p}`));
      return problems;
    },
    respond: () => JSON.parse(JSON.stringify(PLAN_RESPONSE)),
  },
  // branding-admin.controller.ts — `@Get('css')` returns `{ content }`.
  { method: 'get', path: '/v1/admin/brand/css', respond: () => ({ content: 'body { color: red; }' }) },
  // branding-admin.controller.ts — `@Post('css')`: plain `{ content: string }` body, 400 without it, no response body.
  {
    method: 'post',
    path: '/v1/admin/brand/css',
    check: (body) => ((body as Body)?.content ? [] : ['Missing content in body']),
    respond: () => undefined,
  },
];

const IGNORED_READS = new Set(['then', 'toJSON', 'constructor', 'asymmetricMatch', '$$typeof', 'nodeType']);

interface Call { method: Method; path: string; body?: unknown }

function contractServer() {
  const violations: string[] = [];
  const calls: Call[] = [];
  let recording = true;
  const mgmt = new BridgeManagement({ apiKey: 'contract-test', baseUrl: 'http://contract.test' });
  // Every service shares one ManagementHttpClient; replace its transport methods.
  const http = (mgmt.app as unknown as { http: Record<Method, unknown> }).http;

  const track = <T>(value: T, label: string): T => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return new Proxy(value as object, {
      get(target, prop, receiver) {
        if (recording && typeof prop === 'string' && !IGNORED_READS.has(prop) && !(prop in target)) {
          violations.push(`${label}: read "${prop}", which the server response does not declare`);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as T;
  };

  const handle = (method: Method) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const label = `${method.toUpperCase()} ${path}`;
    const route = ROUTES.find((r) => r.method === method && r.path === path);
    if (!route) {
      violations.push(`${label}: the server has no such route`);
      throw new HttpError(`Cannot ${label}`, 404);
    }
    const problems = route.check?.(body) ?? [];
    if (problems.length) {
      violations.push(...problems.map((p) => `${label}: ${p}`));
      throw new HttpError('Bad Request', 400, { message: problems });
    }
    return track(route.respond(body), label);
  };
  for (const m of ['get', 'post', 'put', 'delete'] as Method[]) http[m] = handle(m);

  return {
    mgmt,
    violations,
    calls,
    /** Stop recording reads (vitest's matchers probe objects). */
    done: () => { recording = false; },
  };
}

// ── The stand-in is not vacuous ─────────────────────────────────────────────

describe('contract stand-in (TBP-663)', () => {
  it('rejects a field the server does not declare, the way forbidNonWhitelisted does', async () => {
    const s = contractServer();
    await expect(
      s.mgmt.app.updateCredentials({ sendgridApiKey: 'SG.x' } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.violations).toEqual(['PUT /v1/account/app/credentials: property sendgridApiKey should not exist']);
  });
});

// ── setupSSO ────────────────────────────────────────────────────────────────

describe('workflows.setupSSO ↔ bridge-api (TBP-663)', () => {
  const cases = [
    { provider: 'google', creds: { googleClientId: 'cid', googleClientSecret: 'sec' }, enable: 'googleSsoEnabled' },
    { provider: 'github', creds: { githubClientId: 'cid', githubClientSecret: 'sec' }, enable: 'githubSsoEnabled' },
    { provider: 'linkedin', creds: { linkedinClientId: 'cid', linkedinClientSecret: 'sec' }, enable: 'linkedinSsoEnabled' },
    { provider: 'facebook', creds: { facebookClientId: 'cid', facebookClientSecret: 'sec' }, enable: 'facebookSsoEnabled' },
    {
      provider: 'azure',
      tenantId: 'dir-1',
      creds: { microsoftAzureADClientId: 'cid', microsoftAzureADClientSecret: 'sec', microsoftAzureADTenantId: 'dir-1' },
      enable: 'azureAdSsoEnabled',
    },
  ] as const;

  it.each(cases)('$provider: sends only the API\'s own fields and returns the callback URL', async (c) => {
    const s = contractServer();
    const result = await s.mgmt.workflows.setupSSO({
      provider: c.provider,
      config: { clientId: 'cid', clientSecret: 'sec', ...('tenantId' in c ? { tenantId: c.tenantId } : {}) },
    });
    s.done();

    expect(s.violations).toEqual([]);
    expect(s.calls).toEqual([
      { method: 'put', path: '/v1/account/app/credentials', body: c.creds },
      { method: 'put', path: '/v1/account/app', body: { [c.enable]: true } },
      { method: 'get', path: '/v1/account/app', body: undefined },
    ]);
    expect(result).toMatchObject({ provider: c.provider, enabled: true, callbackUrl: 'https://auth.acme.test/cb' });
  });

  it.each(['saml', 'oidc'])('%s: refuses before sending anything (the API has no fields for it)', async (provider) => {
    const s = contractServer();
    await expect(
      s.mgmt.workflows.setupSSO({ provider, config: { clientId: 'c', clientSecret: 's' } } as never),
    ).rejects.toMatchObject({ code: 'SSO_PROVIDER_NOT_SUPPORTED', message: expect.stringContaining('admin UI') });
    expect(s.calls).toEqual([]);
  });

  it.each(['metadataUrl', 'discoveryUrl'])('config.%s: refuses instead of sending or dropping it', async (key) => {
    const s = contractServer();
    await expect(
      s.mgmt.workflows.setupSSO({
        provider: 'google',
        config: { clientId: 'c', clientSecret: 's', [key]: 'https://idp.test/x' },
      } as never),
    ).rejects.toMatchObject({ code: 'SSO_PROVIDER_NOT_SUPPORTED' });
    expect(s.calls).toEqual([]);
  });

  it('azure without tenantId: refuses before sending anything', async () => {
    const s = contractServer();
    await expect(
      s.mgmt.workflows.setupSSO({ provider: 'azure', config: { clientId: 'c', clientSecret: 's' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('tenantId') });
    expect(s.calls).toEqual([]);
  });

  it('tenantId on a non-azure provider: refuses instead of dropping it', async () => {
    const s = contractServer();
    await expect(
      s.mgmt.workflows.setupSSO({ provider: 'google', config: { clientId: 'c', clientSecret: 's', tenantId: 'd' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(s.calls).toEqual([]);
  });

  it('missing client credentials: refuses before sending anything', async () => {
    const s = contractServer();
    await expect(
      s.mgmt.workflows.setupSSO({ provider: 'github', config: { clientId: 'c' } } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(s.calls).toEqual([]);
  });
});

// ── setupCommunication ──────────────────────────────────────────────────────

describe('workflows.setupCommunication ↔ bridge-api (TBP-663)', () => {
  it('sets only the sender, on the app, and writes no credentials', async () => {
    const s = contractServer();
    const result = await s.mgmt.workflows.setupCommunication({
      config: { fromAddress: 'hello@acme.test', fromName: 'Acme Support' },
    });
    s.done();

    expect(s.violations).toEqual([]);
    expect(s.calls).toEqual([
      { method: 'put', path: '/v1/account/app', body: { emailSenderEmail: 'hello@acme.test', emailSenderName: 'Acme Support' } },
    ]);
    // The server answers with the updated app; the result reports what it stored.
    expect(result).toMatchObject({
      configured: true,
      emailSenderEmail: 'hello@acme.test',
      emailSenderName: 'Acme Support',
    });
  });

  it('name only: sends just the name', async () => {
    const s = contractServer();
    await s.mgmt.workflows.setupCommunication({ config: { fromName: 'Acme' } });
    expect(s.violations).toEqual([]);
    expect(s.calls.map((c) => c.body)).toEqual([{ emailSenderName: 'Acme' }]);
  });

  it.each([
    ['an API key', { provider: 'sendgrid', config: { apiKey: 'SG.x', fromName: 'Acme' } }],
    ['a provider', { provider: 'sendgrid', config: { fromName: 'Acme' } }],
  ])('%s: refuses instead of sending or dropping it', async (_label, params) => {
    const s = contractServer();
    await expect(s.mgmt.workflows.setupCommunication(params as never)).rejects.toMatchObject({
      code: 'EMAIL_PROVIDER_NOT_SUPPORTED',
      message: expect.stringContaining('its own provider'),
    });
    expect(s.calls).toEqual([]);
  });

  it.each([
    ['nothing to set', {}],
    ['an invalid address', { fromAddress: 'not-an-email' }],
    ['an empty name', { fromName: ' ' }],
  ])('%s: refuses before sending anything', async (_label, config) => {
    const s = contractServer();
    await expect(s.mgmt.workflows.setupCommunication({ config })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(s.calls).toEqual([]);
  });
});

// ── Sweep: the other workflow and the branding CSS routes ───────────────────

describe('workflows.setupPayments ↔ bridge-api', () => {
  it('sends only declared fields, including for the plans it creates', async () => {
    const s = contractServer();
    const result = await s.mgmt.workflows.setupPayments({
      stripeSecretKey: 'sk_test_contract',
      stripePublicKey: 'pk_test_contract',
      plans: [{ key: 'pro', name: 'Pro', price: 49, interval: 'year' }],
    });
    s.done();
    expect(s.violations).toEqual([]);
    expect(result.plans).toHaveLength(1);
  });
});

describe('branding CSS ↔ bridge-api (TBP-663)', () => {
  it('updateCss sends the `content` field the server reads', async () => {
    const s = contractServer();
    await expect(s.mgmt.branding.updateCss({ content: 'body { color: red; }' })).resolves.toBeUndefined();
    expect(s.violations).toEqual([]);
    expect(s.calls).toEqual([{ method: 'post', path: '/v1/admin/brand/css', body: { content: 'body { color: red; }' } }]);
  });

  it('getCss exposes the server\'s `content` field', async () => {
    const s = contractServer();
    const css = await s.mgmt.branding.getCss();
    expect(css.content).toBe('body { color: red; }');
    s.done();
    expect(s.violations).toEqual([]);
  });
});
