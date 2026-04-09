import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryAdapter, LocalStorageAdapter } from '../token-storage.js';

// ---------------------------------------------------------------------------
// MemoryAdapter
// ---------------------------------------------------------------------------

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it('get() returns null for a key that has never been set', () => {
    expect(adapter.get('missing')).toBeNull();
  });

  it('set() stores a value that can be retrieved with get()', () => {
    adapter.set('token', 'abc123');
    expect(adapter.get('token')).toBe('abc123');
  });

  it('get() returns the most recently set value for a key', () => {
    adapter.set('token', 'first');
    adapter.set('token', 'second');
    expect(adapter.get('token')).toBe('second');
  });

  it('remove() deletes the key so get() returns null', () => {
    adapter.set('token', 'abc123');
    adapter.remove('token');
    expect(adapter.get('token')).toBeNull();
  });

  it('remove() on a key that was never set does not throw', () => {
    expect(() => adapter.remove('ghost')).not.toThrow();
  });

  it('stores multiple independent keys', () => {
    adapter.set('access', 'a');
    adapter.set('refresh', 'r');
    adapter.set('id', 'i');
    expect(adapter.get('access')).toBe('a');
    expect(adapter.get('refresh')).toBe('r');
    expect(adapter.get('id')).toBe('i');
  });

  it('removing one key does not affect others', () => {
    adapter.set('access', 'a');
    adapter.set('refresh', 'r');
    adapter.remove('access');
    expect(adapter.get('access')).toBeNull();
    expect(adapter.get('refresh')).toBe('r');
  });

  it('different MemoryAdapter instances have independent stores', () => {
    const a = new MemoryAdapter();
    const b = new MemoryAdapter();
    a.set('key', 'from-a');
    expect(b.get('key')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LocalStorageAdapter
// ---------------------------------------------------------------------------

describe('LocalStorageAdapter', () => {
  let mockStorage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };
  let adapter: LocalStorageAdapter;

  beforeEach(() => {
    mockStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    // Replace globalThis.localStorage with the mock for the duration of each test
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    adapter = new LocalStorageAdapter();
  });

  it('get() delegates to localStorage.getItem', () => {
    mockStorage.getItem.mockReturnValue('stored-value');
    const result = adapter.get('my-key');
    expect(mockStorage.getItem).toHaveBeenCalledWith('my-key');
    expect(result).toBe('stored-value');
  });

  it('get() returns null when localStorage.getItem returns null', () => {
    mockStorage.getItem.mockReturnValue(null);
    expect(adapter.get('absent')).toBeNull();
  });

  it('get() returns null if localStorage throws', () => {
    mockStorage.getItem.mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(adapter.get('key')).toBeNull();
  });

  it('set() delegates to localStorage.setItem', () => {
    adapter.set('my-key', 'my-value');
    expect(mockStorage.setItem).toHaveBeenCalledWith('my-key', 'my-value');
  });

  it('set() does not throw if localStorage.setItem throws (storage full)', () => {
    mockStorage.setItem.mockImplementation(() => { throw new DOMException('QuotaExceededError'); });
    expect(() => adapter.set('key', 'value')).not.toThrow();
  });

  it('remove() delegates to localStorage.removeItem', () => {
    adapter.remove('my-key');
    expect(mockStorage.removeItem).toHaveBeenCalledWith('my-key');
  });

  it('remove() does not throw if localStorage.removeItem throws', () => {
    mockStorage.removeItem.mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => adapter.remove('key')).not.toThrow();
  });
});
