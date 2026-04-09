import { httpFetch } from './http.js';
import type { Logger } from './logger.js';

/**
 * HTTP client for Bridge Management API operations.
 * Authenticates via x-api-key header (JWT API token).
 *
 * Wraps the generic `httpFetch` utility with API-key injection
 * and relative-path convenience methods.
 */
export class ManagementHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly logger: Logger,
  ) {}

  async get<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    return httpFetch<T>(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { ...this.authHeaders(), ...extraHeaders },
    }, this.logger);
  }

  async post<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return httpFetch<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.authHeaders(), ...extraHeaders },
      body,
    }, this.logger);
  }

  async put<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return httpFetch<T>(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { ...this.authHeaders(), ...extraHeaders },
      body,
    }, this.logger);
  }

  async delete<T>(path: string, extraHeaders?: Record<string, string>): Promise<T> {
    return httpFetch<T>(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { ...this.authHeaders(), ...extraHeaders },
    }, this.logger);
  }

  private authHeaders(): Record<string, string> {
    return { 'x-api-key': this.apiKey };
  }
}
