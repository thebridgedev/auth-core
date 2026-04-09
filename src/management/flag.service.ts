import type { ManagementHttpClient } from '../management-http.js';
import type {
  FlagResponse, CreateFlagInput, UpdateFlagInput,
  SegmentResponse, SegmentInput,
} from '../management-types.js';

export class FlagManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async list(): Promise<FlagResponse[]> {
    return this.http.get<FlagResponse[]>('/v1/admin/flags/flags');
  }

  async create(data: CreateFlagInput): Promise<FlagResponse> {
    return this.http.post<FlagResponse>('/v1/admin/flags/flag', data);
  }

  async update(flagId: string, data: UpdateFlagInput): Promise<FlagResponse> {
    return this.http.put<FlagResponse>(`/v1/admin/flags/flag/${flagId}`, data);
  }

  async toggle(flagId: string, enabled: boolean): Promise<FlagResponse> {
    return this.http.put<FlagResponse>(`/v1/admin/flags/flag/${flagId}`, { enabled });
  }

  async delete(flagId: string): Promise<void> {
    return this.http.delete<void>(`/v1/admin/flags/flag/${flagId}`);
  }

  async listSegments(): Promise<SegmentResponse[]> {
    return this.http.get<SegmentResponse[]>('/v1/admin/flags/segments');
  }

  async createSegment(data: SegmentInput): Promise<SegmentResponse> {
    return this.http.post<SegmentResponse>('/v1/admin/flags/segment', data);
  }

  async updateSegment(segmentId: string, data: SegmentInput): Promise<SegmentResponse> {
    return this.http.put<SegmentResponse>(`/v1/admin/flags/segment/${segmentId}`, data);
  }

  async deleteSegment(segmentId: string): Promise<void> {
    return this.http.delete<void>(`/v1/admin/flags/segment/${segmentId}`);
  }
}
