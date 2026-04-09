import type { ManagementHttpClient } from '../management-http.js';
import type { OnboardingResponse, UpdateOnboardingRequest } from '../management-types.js';

export class OnboardingManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async get(): Promise<OnboardingResponse> {
    return this.http.get<OnboardingResponse>('/v1/admin/onboarding');
  }

  async update(data: UpdateOnboardingRequest): Promise<OnboardingResponse> {
    return this.http.put<OnboardingResponse>('/v1/admin/onboarding', data);
  }
}
