import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenManager } from '../token-manager.js';
import { MemoryAdapter } from '../token-storage.js';

describe('TokenManager minimal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty', () => {
    const storage = new MemoryAdapter();
    const manager = new TokenManager(storage, vi.fn(), { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
    expect(manager.getTokens()).toBeNull();
  });
});
