import type { ManagementHttpClient } from '../management-http.js';
import type { EventQuery, EventResult } from '../management-types.js';

/**
 * TBP-594 — this used to `GET /v1/event-log`, which the API has never served.
 * `bridge event list` answered:
 *
 *   {"code":"HTTP_404","message":"Cannot GET /v1/event-log"}
 *
 * The event-log controller exposes `POST /` (ingest), `POST /query` (a
 * time-bucketed aggregation that requires an explicit `eventName`, `from` and
 * `to`), and `GET /audit` — a plain reverse-chronological listing. `GET /audit`
 * is the one that matches "show me recent events", so that is what this calls.
 *
 * `appId` is deliberately not sent: the server derives it from the API token.
 */
export class EventManagementService {
  constructor(private readonly http: ManagementHttpClient) {}

  async query(params?: EventQuery): Promise<EventResult[]> {
    const search = new URLSearchParams();

    // `type` is the top-level `eventName` on the audit document, not a member
    // of its `extracted` map — see the note in the API's AuditLogQueryDto.
    if (params?.type) search.set('eventName', params.type);
    if (params?.tenantId) search.set('tenantId', params.tenantId);
    if (params?.userId) search.set('userId', params.userId);
    if (params?.since) search.set('from', toIsoDate(params.since));
    if (params?.limit) search.set('limit', String(params.limit));

    const qs = search.toString();
    const rows = await this.http.get<AuditLogRow[]>(
      `/v1/event-log/audit${qs ? `?${qs}` : ''}`,
    );

    // `/audit` returns the stored document shape. Map it onto the published
    // `EventResult` rather than widening the public type to match a storage
    // detail — and rather than leaving the declared type a lie, which is how
    // the wrong endpoint went unnoticed in the first place.
    return (rows ?? []).map((row) => ({
      id: row.rawEventId,
      type: row.eventName,
      tenantId: asString(row.extracted?.tenantId),
      userId: asString(row.extracted?.userId),
      data: row.extracted,
      createdAt: row.timestamp,
    }));
  }
}

/** The raw shape `GET /v1/event-log/audit` returns. */
interface AuditLogRow {
  timestamp: string;
  eventName: string;
  extracted?: Record<string, unknown>;
  rawEventId: string;
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

/**
 * The CLI documents `--since` as `"24h"`, `"7d"` or an ISO date, but the API
 * validates `from` with `@IsDateString()`. Passing "24h" straight through
 * fails validation, so relative forms are resolved here.
 */
function toIsoDate(since: string): string {
  const relative = /^(\d+)([hdwm])$/.exec(since.trim());
  if (!relative) return since;

  const amount = Number(relative[1]);
  const unitMs: Record<string, number> = {
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    m: 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - amount * unitMs[relative[2]]).toISOString();
}
