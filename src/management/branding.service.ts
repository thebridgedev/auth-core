import type { ManagementHttpClient } from '../management-http.js';
import type { BrandingResponse, UpdateBrandingRequest, CssFileResponse, UpdateCssFileRequest } from '../management-types.js';

export class BrandingManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async get(): Promise<BrandingResponse> {
    return this.http.get<BrandingResponse>('/v1/admin/brand');
  }

  async update(data: UpdateBrandingRequest): Promise<BrandingResponse> {
    return this.http.put<BrandingResponse>('/v1/admin/brand', data);
  }

  async getCss(): Promise<CssFileResponse> {
    return this.http.get<CssFileResponse>('/v1/admin/brand/css');
  }

  async updateCss(data: UpdateCssFileRequest): Promise<CssFileResponse> {
    return this.http.post<CssFileResponse>('/v1/admin/brand/css', data);
  }

  async deleteCss(): Promise<void> {
    return this.http.delete<void>('/v1/admin/brand/css');
  }
}
