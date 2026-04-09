import type { AppManagementService } from './app.service.js';
import type { PlanManagementService } from './plan.service.js';
import type {
  SetupSSOParams, SetupSSOResult,
  SetupPaymentsParams, SetupPaymentsResult,
  SetupCommunicationParams, SetupCommunicationResult,
  PlanResponse,
} from '../management-types.js';

export class ManagementWorkflows {
  constructor(
    private readonly appService: AppManagementService,
    private readonly planService: PlanManagementService,
  ) {}

  /**
   * Enable an SSO provider and return the callback URL.
   * Thick operation: saves credentials + fetches updated app config.
   */
  async setupSSO(params: SetupSSOParams): Promise<SetupSSOResult> {
    const ssoFieldMap: Record<string, string> = {
      google: 'googleSsoEnabled',
      azure: 'azureAdSsoEnabled',
      github: 'githubSsoEnabled',
      linkedin: 'linkedinSsoEnabled',
      facebook: 'facebookSsoEnabled',
      apple: 'appleSsoEnabled',
    };

    // Save provider credentials
    await this.appService.updateCredentials({
      [`${params.provider}ClientId`]: params.config.clientId,
      [`${params.provider}ClientSecret`]: params.config.clientSecret,
      ...(params.config.metadataUrl ? { samlMetadataUrl: params.config.metadataUrl } : {}),
      ...(params.config.discoveryUrl ? { oidcDiscoveryUrl: params.config.discoveryUrl } : {}),
    });

    // Enable the SSO provider
    const enableField = ssoFieldMap[params.provider];
    if (enableField) {
      await this.appService.update({ [enableField]: true } as any);
    }

    // Fetch updated app config (includes callback URL)
    const app = await this.appService.get();

    return {
      provider: params.provider,
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
   * Configure an email/communication provider.
   * Thick operation: saves provider credentials + updates app email settings.
   */
  async setupCommunication(params: SetupCommunicationParams): Promise<SetupCommunicationResult> {
    // Save provider credentials
    await this.appService.updateCredentials({
      [`${params.provider}ApiKey`]: params.config.apiKey,
    });

    // Update app email settings if provided
    if (params.config.fromAddress || params.config.fromName) {
      await this.appService.update({
        ...(params.config.fromAddress ? { emailSenderEmail: params.config.fromAddress } : {}),
        ...(params.config.fromName ? { emailSenderName: params.config.fromName } : {}),
      });
    }

    const app = await this.appService.get();

    return {
      provider: params.provider,
      configured: true,
      app,
    };
  }
}
