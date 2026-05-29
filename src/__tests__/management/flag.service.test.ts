// TBP-235 — typed FF 2.0 fields at the management SDK boundary.
//
// This file is primarily a *type* assertion suite. The behaviour of
// FlagManagementService is a thin pass-through over ManagementHttpClient, so
// we only assert (a) the HTTP method/URL it picks and (b) that the new 2.0
// payload shape compiles without `any` casts at the call site.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlagManagementService } from '../../management/flag.service.js';
import type { ManagementHttpClient } from '../../management-http.js';
import type {
  CreateFlagInput,
  FlagResponse,
  FlagSchedule,
  Rule,
  UpdateFlagInput,
} from '../../management-types.js';

function createMockHttp(): ManagementHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ManagementHttpClient;
}

describe('FlagManagementService — FF 2.0 typed payloads (TBP-235)', () => {
  let http: ReturnType<typeof createMockHttp>;
  let service: FlagManagementService;

  beforeEach(() => {
    http = createMockHttp();
    service = new FlagManagementService(http as any);
  });

  it('create() accepts a fully typed 2.0 payload — no casts at call site', async () => {
    const rule: Rule = {
      branches: [
        {
          conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }],
          returnValue: true,
        },
      ],
      otherwiseValue: false,
      rolloutPct: 100,
    };

    const input: CreateFlagInput = {
      key: 'new-onboarding',
      description: 'Pack-3 onboarding flow',
      state: 'on-with-rule',
      valueType: 'boolean',
      offValue: false,
      onValue: true,
      rule,
    };

    (http.post as any).mockResolvedValue({ id: 'f1', key: input.key });

    const result = await service.create(input);

    expect(http.post).toHaveBeenCalledWith('/v1/admin/flags/flag', input);
    expect(result).toEqual({ id: 'f1', key: input.key });
  });

  it('update() accepts a 2.0 schedule payload — and accepts null to clear it', async () => {
    const schedule: FlagSchedule = { at: '2026-06-01T09:00:00.000Z', state: 'on' };

    const setInput: UpdateFlagInput = { schedule };
    const clearInput: UpdateFlagInput = { schedule: null };

    (http.put as any).mockResolvedValue({ id: 'f1' });

    await service.update('f1', setInput);
    await service.update('f1', clearInput);

    expect(http.put).toHaveBeenNthCalledWith(1, '/v1/admin/flags/flag/f1', setInput);
    expect(http.put).toHaveBeenNthCalledWith(2, '/v1/admin/flags/flag/f1', clearInput);
  });

  it('FlagResponse exposes the FF 2.0 + observability fields', () => {
    // Compile-only assertion: assembling a FlagResponse with the new fields
    // must succeed. If any field is missing or wrongly typed, tsc will fail.
    const sample: FlagResponse = {
      id: 'f1',
      key: 'k',
      description: 'd',
      defaultValue: false,
      segments: [],
      enabled: true,
      state: 'on-with-rule',
      valueType: 'string',
      offValue: 'control',
      onValue: 'treatment',
      rule: {
        branches: [],
        otherwiseValue: 'control',
        rolloutPct: 50,
      },
      schedule: { at: '2026-07-01T00:00:00.000Z', state: 'off' },
      evalCount: 42,
      lastEvalAt: '2026-05-18T08:00:00.000Z',
    };

    expect(sample.state).toBe('on-with-rule');
    expect(sample.evalCount).toBe(42);
  });

  it('1.0 legacy callers still compile (additive change, no removals)', async () => {
    const legacyInput: CreateFlagInput = {
      key: 'legacy',
      defaultValue: true,
      enabled: true,
      segments: ['s1'],
    };
    (http.post as any).mockResolvedValue({ id: 'f2' });

    await service.create(legacyInput);

    expect(http.post).toHaveBeenCalledWith('/v1/admin/flags/flag', legacyInput);
  });
});
