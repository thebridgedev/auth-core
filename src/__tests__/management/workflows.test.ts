import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagementWorkflows } from '../../management/workflows.js';
import type { AppManagementService } from '../../management/app.service.js';
import type { PlanManagementService } from '../../management/plan.service.js';

/*
 * setupSSO / setupCommunication are covered by server-contract.test.ts, which
 * checks every request body against the fields bridge-api declares. The mocks
 * that lived here repeated the workflows' own wrong field names
 * (`sendgridApiKey`), so they stayed green while every real call 400'd
 * (TBP-663).
 */

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
});
