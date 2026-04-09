import type { ManagementHttpClient } from '../management-http.js';
import type { EventQuery, EventResult } from '../management-types.js';

export class EventManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async query(params?: EventQuery): Promise<EventResult[]> {
    const queryParts: string[] = [];
    if (params?.type) queryParts.push(`type=${encodeURIComponent(params.type)}`);
    if (params?.tenantId) queryParts.push(`tenantId=${encodeURIComponent(params.tenantId)}`);
    if (params?.userId) queryParts.push(`userId=${encodeURIComponent(params.userId)}`);
    if (params?.since) queryParts.push(`since=${encodeURIComponent(params.since)}`);
    if (params?.limit) queryParts.push(`limit=${params.limit}`);

    const qs = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    return this.http.get<EventResult[]>(`/v1/event-log${qs}`);
  }
}
