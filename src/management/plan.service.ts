import type { ManagementHttpClient } from '../management-http.js';
import type { PlanResponse, CreatePlanRequest, UpdatePlanRequest } from '../management-types.js';

export class PlanManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async list(): Promise<PlanResponse[]> {
    return this.http.get<PlanResponse[]>('/v1/account/payments/plan');
  }

  async create(data: CreatePlanRequest): Promise<PlanResponse> {
    return this.http.post<PlanResponse>('/v1/account/payments/plan', data);
  }

  async update(planKey: string, data: UpdatePlanRequest): Promise<PlanResponse> {
    return this.http.put<PlanResponse>(`/v1/account/payments/plan/${planKey}`, data);
  }
}
