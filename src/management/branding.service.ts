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

  /**
   * Replace the app's custom CSS. The server answers with no body.
   *
   * @remarks TBP-663 — the body field is `content` (it used to be `cssFile`,
   * which the server never read, so every call failed with a 400), and this
   * now resolves to `void` instead of a `CssFileResponse` the server never sent.
   */
  async updateCss(data: UpdateCssFileRequest): Promise<void> {
    await this.http.post<void>('/v1/admin/brand/css', { content: data.content });
  }

  async deleteCss(): Promise<void> {
    return this.http.delete<void>('/v1/admin/brand/css');
  }
}
