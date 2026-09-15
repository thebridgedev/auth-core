import { BridgeAuthError } from '../errors.js';
import type { AppManagementService } from './app.service.js';
import type { PlanManagementService } from './plan.service.js';
import type {
  SetupSSOParams, SetupSSOResult, SSOProvider,
  SetupPaymentsParams, SetupPaymentsResult,
  SetupCommunicationParams, SetupCommunicationResult,
  PlanResponse, UpdateAppRequest, UpdateCredentialsRequest,
} from '../management-types.js';

type CredentialField = keyof UpdateCredentialsRequest;
type SsoEnableField =
  | 'googleSsoEnabled' | 'githubSsoEnabled' | 'linkedinSsoEnabled' | 'facebookSsoEnabled' | 'azureAdSsoEnabled';

/*
 * TBP-663 — the one mapping from provider to the API's own field names
 * (bridge-api UpdateCredentialsRequestDto / UpdateAppRequestDto). This used to
 * be derived as `${provider}ClientId`, which only happens to match for
 * google/github/linkedin/facebook: azure became `azureClientId` (the API wants
 * microsoftAzureAD*, plus a tenant id there was no way to pass), and every
 * such call 400'd under forbidNonWhitelisted. Same table as bridge-api's MCP
 * `setup_sso` tool; `server-contract.test.ts` pins it to the server's fields.
 */
const SSO_PROVIDERS: Record<SSOProvider, {
  clientId: CredentialField;
  clientSecret: CredentialField;
  tenantId?: CredentialField;
  enable: SsoEnableField;
}> = {
  google: { clientId: 'googleClientId', clientSecret: 'googleClientSecret', enable: 'googleSsoEnabled' },
  github: { clientId: 'githubClientId', clientSecret: 'githubClientSecret', enable: 'githubSsoEnabled' },
  linkedin: { clientId: 'linkedinClientId', clientSecret: 'linkedinClientSecret', enable: 'linkedinSsoEnabled' },
  facebook: { clientId: 'facebookClientId', clientSecret: 'facebookClientSecret', enable: 'facebookSsoEnabled' },
  azure: {
    clientId: 'microsoftAzureADClientId',
    clientSecret: 'microsoftAzureADClientSecret',
    tenantId: 'microsoftAzureADTenantId',
    enable: 'azureAdSsoEnabled',
  },
};

const SUPPORTED_SSO = Object.keys(SSO_PROVIDERS).join(', ');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const invalid = (message: string) => new BridgeAuthError(`${message} Nothing was saved.`, 'INVALID_ARGUMENT');

export class ManagementWorkflows {
  constructor(
    private readonly appService: AppManagementService,
    private readonly planService: PlanManagementService,
  ) {}

  /**
   * Enable a social / enterprise SSO login provider and return the app's
   * callback URL. Saves the provider credentials, turns the provider on, and
   * reads the app back.
   *
   * Register the returned `callbackUrl` in the provider's console, or logins
   * fail with a redirect mismatch.
   *
   * Throws `BridgeAuthError` before anything is saved when:
   * - `SSO_PROVIDER_NOT_SUPPORTED`: the provider is not one of google, azure,
   *   github, linkedin, facebook, or a removed option was passed.
   * - `INVALID_ARGUMENT`: `clientId` / `clientSecret` is missing, `tenantId` is
   *   missing for azure, or `tenantId` was passed for any other provider.
   *
   * @remarks TBP-663 — `'saml'` / `'oidc'` providers and `config.metadataUrl` /
   * `config.discoveryUrl` were removed: the management API has no fields for
   * SAML or OIDC connections, so those calls always failed with a 400. They are
   * configured in the Bridge admin UI. Passing them now throws
   * `SSO_PROVIDER_NOT_SUPPORTED` instead of being sent. Azure now takes
   * `config.tenantId`, which it needs.
   */
  async setupSSO(params: SetupSSOParams): Promise<SetupSSOResult> {
    const provider = params?.provider;
    const fields = Object.prototype.hasOwnProperty.call(SSO_PROVIDERS, provider)
      ? SSO_PROVIDERS[provider]
      : undefined;
    if (!fields) {
      const p = String(provider);
      throw new BridgeAuthError(
        p === 'saml' || p === 'oidc'
          ? `setupSSO: "${p}" cannot be configured through the management API — it has no fields for ` +
            'SAML or OIDC connections. Set them up in the Bridge admin UI. Nothing was saved.'
          : `setupSSO: unknown provider "${p}". Supported: ${SUPPORTED_SSO}. Nothing was saved.`,
        'SSO_PROVIDER_NOT_SUPPORTED',
      );
    }

    const config = (params.config ?? {}) as SetupSSOParams['config'] & Record<string, unknown>;
    for (const removed of ['metadataUrl', 'discoveryUrl']) {
      if (config[removed] !== undefined) {
        throw new BridgeAuthError(
          `setupSSO: config.${removed} was removed — the management API has no field for it ` +
            '(SAML and OIDC are configured in the Bridge admin UI). Nothing was saved.',
          'SSO_PROVIDER_NOT_SUPPORTED',
        );
      }
    }
    if (!config.clientId || !config.clientSecret) {
      throw invalid('setupSSO: config.clientId and config.clientSecret are required (from the provider console).');
    }
    if (fields.tenantId && !config.tenantId) {
      throw invalid(
        'setupSSO: azure needs config.tenantId — the Directory (tenant) ID from the Entra ID app registration.',
      );
    }
    if (!fields.tenantId && config.tenantId !== undefined) {
      throw invalid(`setupSSO: config.tenantId applies to azure only, not "${provider}".`);
    }

    const credentials: UpdateCredentialsRequest = {};
    credentials[fields.clientId] = config.clientId;
    credentials[fields.clientSecret] = config.clientSecret;
    if (fields.tenantId) credentials[fields.tenantId] = config.tenantId;
    await this.appService.updateCredentials(credentials);

    const enable: UpdateAppRequest = {};
    enable[fields.enable] = true;
    await this.appService.update(enable);

    // Fetch updated app config (includes callback URL)
    const app = await this.appService.get();

    return {
      provider,
      enabled: true,
      callbackUrl: app.defaultCallbackUri,
      app,
    };
  }

  /**
   * Connect Stripe and optionally create subscription plans.
   * Thick operation: saves Stripe credentials + enables payments + creates plans.
   */
  async setupPayments(params: SetupPaymentsParams): Promise<SetupPaymentsResult> {
    // Save Stripe credentials
    await this.appService.updateCredentials({
      stripeSecretKey: params.stripeSecretKey,
      ...(params.stripePublicKey ? { stripePublicKey: params.stripePublicKey } : {}),
    });

    // Enable Stripe
    await this.appService.update({ stripeEnabled: true });

    // Create plans if provided
    const createdPlans: PlanResponse[] = [];
    if (params.plans) {
      for (const plan of params.plans) {
        const created = await this.planService.create({
          key: plan.key,
          name: plan.name,
          prices: [{
            amount: plan.price,
            currency: plan.currency ?? 'usd',
            recurrenceInterval: plan.interval ?? 'month',
          }],
        });
        createdPlans.push(created);
      }
    }

    const app = await this.appService.get();

    return {
      stripeConnected: true,
      plans: createdPlans,
      app,
    };
  }

  /**
   * Set the sender of the transactional email Bridge sends for the app
   * (invitations, password resets, magic links, MFA codes). Bridge delivers
   * that email through its own provider; only the sender is per-app.
   *
   * A NEW `fromAddress` is verified by email before it is used: until the link
   * in the verification email is clicked, email keeps coming from the Bridge
   * default sender.
   *
   * Throws `BridgeAuthError` before anything is saved when:
   * - `EMAIL_PROVIDER_NOT_SUPPORTED`: a removed option (`provider`,
   *   `config.apiKey`) was passed.
   * - `INVALID_ARGUMENT`: neither `fromAddress` nor `fromName` was given,
   *   `fromAddress` is not an email address, or `fromName` is empty.
   *
   * @remarks TBP-663 — `provider` and `config.apiKey` were removed. The
   * workflow wrote the key as `${provider}ApiKey` (e.g. `sendgridApiKey`) to
   * the credentials route, which has never had such a field, so every call
   * failed with a 400. There is no email provider or key to configure. Passing
   * either now throws `EMAIL_PROVIDER_NOT_SUPPORTED` instead of being sent.
   */
  async setupCommunication(params: SetupCommunicationParams): Promise<SetupCommunicationResult> {
    const legacy = params as unknown as { provider?: unknown; config?: { apiKey?: unknown } } | undefined;
    if (legacy?.provider !== undefined || legacy?.config?.apiKey !== undefined) {
      throw new BridgeAuthError(
        'setupCommunication: provider and config.apiKey were removed — Bridge sends all email through ' +
          'its own provider, so there is no provider or API key to configure (the API has never accepted ' +
          'one). Pass only config.fromAddress and/or config.fromName. Nothing was saved.',
        'EMAIL_PROVIDER_NOT_SUPPORTED',
      );
    }

    const { fromAddress, fromName } = params?.config ?? {};
    if (fromAddress === undefined && fromName === undefined) {
      throw invalid('setupCommunication: nothing to set — pass config.fromAddress, config.fromName, or both.');
    }
    if (fromAddress !== undefined && !EMAIL.test(fromAddress)) {
      throw invalid(`setupCommunication: config.fromAddress must be an email address, e.g. "no-reply@example.com".`);
    }
    if (fromName !== undefined && fromName.trim() === '') {
      throw invalid('setupCommunication: config.fromName must not be empty.');
    }

    const update: UpdateAppRequest = {};
    if (fromAddress !== undefined) update.emailSenderEmail = fromAddress;
    if (fromName !== undefined) update.emailSenderName = fromName;
    const app = await this.appService.update(update);

    return {
      configured: true,
      emailSenderEmail: app.emailSenderEmail ?? null,
      emailSenderName: app.emailSenderName ?? null,
      app,
    };
  }
}
