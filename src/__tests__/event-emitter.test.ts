import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from '../event-emitter.js';
import type { TokenSet } from '../types.js';

const makeTokenSet = (): TokenSet => ({
  accessToken: 'access',
  refreshToken: 'refresh',
  idToken: 'id',
});

describe('EventEmitter', () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  describe('on()', () => {
    it('registers a handler that is called when the event is emitted', () => {
      const handler = vi.fn();
      emitter.on('auth:logout', handler);
      emitter.emit('auth:logout', undefined as void);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('passes event data to the handler', () => {
      const handler = vi.fn();
      const tokens = makeTokenSet();
      emitter.on('auth:login', handler);
      emitter.emit('auth:login', tokens);
      expect(handler).toHaveBeenCalledWith(tokens);
    });

    it('returns an unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = emitter.on('auth:logout', handler);
      expect(typeof unsub).toBe('function');
    });

    it('allows multiple handlers for the same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      emitter.on('auth:logout', h1);
      emitter.on('auth:logout', h2);
      emitter.emit('auth:logout', undefined as void);
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('registering the same handler twice only calls it once per emit', () => {
      const handler = vi.fn();
      emitter.on('auth:logout', handler);
      emitter.on('auth:logout', handler);
      emitter.emit('auth:logout', undefined as void);
      // Set semantics — duplicate handler is stored only once
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('emit()', () => {
    it('does not throw when no handlers are registered', () => {
      expect(() => emitter.emit('auth:logout', undefined as void)).not.toThrow();
    });

    it('calls all registered handlers with the provided data', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const tokens = makeTokenSet();
      emitter.on('auth:login', h1);
      emitter.on('auth:login', h2);
      emitter.emit('auth:login', tokens);
      expect(h1).toHaveBeenCalledWith(tokens);
      expect(h2).toHaveBeenCalledWith(tokens);
    });

    it('does not call handlers for a different event', () => {
      const handler = vi.fn();
      emitter.on('auth:login', handler);
      emitter.emit('auth:logout', undefined as void);
      expect(handler).not.toHaveBeenCalled();
    });

    it('swallows errors thrown by a listener', () => {
      const throwing = vi.fn(() => { throw new Error('listener blew up'); });
      const normal = vi.fn();
      emitter.on('auth:logout', throwing);
      emitter.on('auth:logout', normal);
      expect(() => emitter.emit('auth:logout', undefined as void)).not.toThrow();
      expect(normal).toHaveBeenCalledTimes(1);
    });

    it('continues calling remaining handlers after one throws', () => {
      const h1 = vi.fn(() => { throw new Error('boom'); });
      const h2 = vi.fn();
      emitter.on('auth:logout', h1);
      emitter.on('auth:logout', h2);
      emitter.emit('auth:logout', undefined as void);
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });

  describe('off()', () => {
    it('removes the specified handler so it is no longer called', () => {
      const handler = vi.fn();
      emitter.on('auth:logout', handler);
      emitter.off('auth:logout', handler);
      emitter.emit('auth:logout', undefined as void);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not affect other handlers for the same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      emitter.on('auth:logout', h1);
      emitter.on('auth:logout', h2);
      emitter.off('auth:logout', h1);
      emitter.emit('auth:logout', undefined as void);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('does not throw when removing a handler that was never registered', () => {
      const handler = vi.fn();
      expect(() => emitter.off('auth:logout', handler)).not.toThrow();
    });

    it('does not throw when removing a handler for an event with no listeners', () => {
      const handler = vi.fn();
      expect(() => emitter.off('auth:login', handler)).not.toThrow();
    });
  });

  describe('unsubscribe function returned from on()', () => {
    it('removes the handler when called', () => {
      const handler = vi.fn();
      const unsub = emitter.on('auth:logout', handler);
      unsub();
      emitter.emit('auth:logout', undefined as void);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not affect other handlers when called', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub = emitter.on('auth:logout', h1);
      emitter.on('auth:logout', h2);
      unsub();
      emitter.emit('auth:logout', undefined as void);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('calling unsub twice does not throw', () => {
      const handler = vi.fn();
      const unsub = emitter.on('auth:logout', handler);
      unsub();
      expect(() => unsub()).not.toThrow();
    });
  });

  describe('removeAllListeners()', () => {
    it('removes all handlers across all events', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();
      emitter.on('auth:login', h1);
      emitter.on('auth:logout', h2);
      emitter.on('auth:logout', h3);
      emitter.removeAllListeners();
      emitter.emit('auth:login', makeTokenSet());
      emitter.emit('auth:logout', undefined as void);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
      expect(h3).not.toHaveBeenCalled();
    });

    it('does not throw when called with no listeners registered', () => {
      expect(() => emitter.removeAllListeners()).not.toThrow();
    });

    it('allows new handlers to be registered after clearing', () => {
      const h1 = vi.fn();
      emitter.on('auth:logout', h1);
      emitter.removeAllListeners();
      const h2 = vi.fn();
      emitter.on('auth:logout', h2);
      emitter.emit('auth:logout', undefined as void);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });
});
