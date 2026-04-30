import { createLogger } from '../logger.js';
import { ManagementHttpClient } from '../management-http.js';
import type { ManagementConfig } from '../management-types.js';
import { AppManagementService } from './app.service.js';
import { TenantManagementService } from './tenant.service.js';
import { UserManagementService } from './user.service.js';
import { RoleManagementService } from './role.service.js';
import { FlagManagementService } from './flag.service.js';
import { BrandingManagementService } from './branding.service.js';
import { PlanManagementService } from './plan.service.js';
import { TokenManagementService } from './token.service.js';
import { EventManagementService } from './event.service.js';
import { OnboardingManagementService } from './onboarding.service.js';
import { ManagementWorkflows } from './workflows.js';

const DEFAULT_BASE_URL = 'https://api.thebridge.dev';

/**
 * Management API facade for Bridge platform.
 *
 * Authenticates via API key (x-api-key header).
 * Use this for programmatic management operations — CLI tools, CI/CD, AI agents.
 *
 * @example
 * ```typescript
 * const mgmt = new BridgeManagement({ apiKey: process.env.BRIDGE_API_KEY });
 * const tenants = await mgmt.tenants.list();
 * const app = await mgmt.app.get();
 * ```
 */
export class BridgeManagement {
  readonly app: AppManagementService;
  readonly tenants: TenantManagementService;
  readonly users: UserManagementService;
  readonly roles: RoleManagementService;
  readonly flags: FlagManagementService;
  readonly branding: BrandingManagementService;
  readonly plans: PlanManagementService;
  readonly tokens: TokenManagementService;
  readonly events: EventManagementService;
  readonly onboarding: OnboardingManagementService;
  readonly workflows: ManagementWorkflows;

  constructor(config: ManagementConfig) {
    const logger = createLogger(config.debug ?? false);
    const http = new ManagementHttpClient(
      config.baseUrl ?? DEFAULT_BASE_URL,
      config.apiKey,
      logger,
    );

    this.app = new AppManagementService(http);
    this.tenants = new TenantManagementService(http);
    this.users = new UserManagementService(http);
    this.roles = new RoleManagementService(http);
    this.flags = new FlagManagementService(http);
    this.branding = new BrandingManagementService(http);
    this.plans = new PlanManagementService(http);
    this.tokens = new TokenManagementService(http);
    this.events = new EventManagementService(http);
    this.onboarding = new OnboardingManagementService(http);
    this.workflows = new ManagementWorkflows(this.app, this.plans);
  }
}
