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

  /**
   * Quick on/off switch: `true` sets `state: "on"`, `false` sets `state: "off"`.
   *
   * TBP-548. This used to PUT `{ enabled }`, the Feature Flags 1.0 boolean.
   * FF 2.0 dropped that field from the flag document entirely and decides
   * every evaluation on `state` alone, and the server's write DTO strips
   * anything it does not declare — so the old payload arrived as `{}`. The
   * request returned 200 with the untouched flag, and the caller was told the
   * toggle had worked while the flag kept serving exactly as before. Writing
   * `state` is the same mapping the MCP `toggle_feature_flag` tool settled on
   * (TBP-587), so both surfaces move a flag the same way.
   *
   * Callers that may be toggling a `state: "on-with-rule"` flag ON should
   * check first: `"on"` returns `onValue` to everyone and stops the rule being
   * consulted, which widens the audience rather than flipping a switch. The
   * rule document survives either way, so toggling OFF is reversible.
   */
  async toggle(flagId: string, enabled: boolean): Promise<FlagResponse> {
    return this.http.put<FlagResponse>(`/v1/admin/flags/flag/${flagId}`, {
      state: enabled ? 'on' : 'off',
    });
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
