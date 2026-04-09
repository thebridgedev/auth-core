import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagementWorkflows } from '../../management/workflows.js';
import type { AppManagementService } from '../../management/app.service.js';
import type { PlanManagementService } from '../../management/plan.service.js';

const mockApp = { id: 'app-1', name: 'Test', defaultCallbackUri: 'https://app.test/callback' };

function createMockAppService(): AppManagementService {
  return {
    get: vi.fn().mockResolvedValue(mockApp),
    update: vi.fn().mockResolvedValue(mockApp),
    updateCredentials: vi.fn().mockResolvedValue({}),
    getCredentialsState: vi.fn(),
  } as unknown as AppManagementService;
}

function createMockPlanService(): PlanManagementService {
  return {
    list: vi.fn(),
    create: vi.fn().mockImplementation((input) => Promise.resolve({ ...input, prices: input.prices ?? [] })),
    update: vi.fn(),
  } as unknown as PlanManagementService;
}

describe('ManagementWorkflows', () => {
  let appService: ReturnType<typeof createMockAppService>;
  let planService: ReturnType<typeof createMockPlanService>;
  let workflows: ManagementWorkflows;

  beforeEach(() => {
    appService = createMockAppService();
    planService = createMockPlanService();
    workflows = new ManagementWorkflows(appService as any, planService as any);
  });

  describe('setupSSO', () => {
    it('saves credentials, enables provider, and returns callback URL', async () => {
      const result = await workflows.setupSSO({
        provider: 'google',
        config: { clientId: 'goog-id', clientSecret: 'goog-secret' },
      });

      expect(appService.updateCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ googleClientId: 'goog-id', googleClientSecret: 'goog-secret' }),
      );
      expect(appService.update).toHaveBeenCalledWith({ googleSsoEnabled: true });
      expect(result.provider).toBe('google');
      expect(result.enabled).toBe(true);
      expect(result.callbackUrl).toBe('https://app.test/callback');
    });
  });

  describe('setupPayments', () => {
    it('connects Stripe and creates plans', async () => {
      const result = await workflows.setupPayments({
        stripeSecretKey: 'sk_test_xxx',
        plans: [
          { key: 'free', name: 'Free', price: 0 },
          { key: 'pro', name: 'Pro', price: 49 },
        ],
      });

      expect(appService.updateCredentials).toHaveBeenCalledWith({ stripeSecretKey: 'sk_test_xxx' });
      expect(appService.update).toHaveBeenCalledWith({ stripeEnabled: true });
      expect(planService.create).toHaveBeenCalledTimes(2);
      expect(result.stripeConnected).toBe(true);
      expect(result.plans).toHaveLength(2);
    });

    it('works without plans', async () => {
      const result = await workflows.setupPayments({ stripeSecretKey: 'sk_test_xxx' });

      expect(planService.create).not.toHaveBeenCalled();
      expect(result.plans).toHaveLength(0);
    });
  });

  describe('setupCommunication', () => {
    it('saves provider credentials and updates email settings', async () => {
      const result = await workflows.setupCommunication({
        provider: 'sendgrid',
        config: { apiKey: 'sg-key', fromAddress: 'noreply@acme.com', fromName: 'Acme' },
      });

      expect(appService.updateCredentials).toHaveBeenCalledWith({ sendgridApiKey: 'sg-key' });
      expect(appService.update).toHaveBeenCalledWith({
        emailSenderEmail: 'noreply@acme.com',
        emailSenderName: 'Acme',
      });
      expect(result.configured).toBe(true);
    });
  });
});
