import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('when debug=true', () => {
    it('debug() logs to console.debug with [bridge-auth] prefix', () => {
      const logger = createLogger(true);
      logger.debug('test message', 42);
      expect(console.debug).toHaveBeenCalledWith('[bridge-auth]', 'test message', 42);
    });

    it('warn() logs to console.warn with [bridge-auth] prefix', () => {
      const logger = createLogger(true);
      logger.warn('watch out', { detail: 'info' });
      expect(console.warn).toHaveBeenCalledWith('[bridge-auth]', 'watch out', { detail: 'info' });
    });

    it('error() logs to console.error with [bridge-auth] prefix', () => {
      const logger = createLogger(true);
      logger.error('something failed');
      expect(console.error).toHaveBeenCalledWith('[bridge-auth]', 'something failed');
    });
  });

  describe('when debug=false', () => {
    it('debug() does not log anything', () => {
      const logger = createLogger(false);
      logger.debug('should not appear');
      expect(console.debug).not.toHaveBeenCalled();
    });

    it('warn() does not log anything', () => {
      const logger = createLogger(false);
      logger.warn('should not appear');
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('error() still logs to console.error', () => {
      const logger = createLogger(false);
      logger.error('always log errors');
      expect(console.error).toHaveBeenCalledWith('[bridge-auth]', 'always log errors');
    });

    it('error() is not affected by the debug flag', () => {
      const loggerOff = createLogger(false);
      const loggerOn = createLogger(true);
      loggerOff.error('err1');
      loggerOn.error('err2');
      expect(console.error).toHaveBeenCalledTimes(2);
    });
  });

  describe('prefix', () => {
    it('always uses [bridge-auth] as the prefix for error', () => {
      const logger = createLogger(false);
      logger.error('msg');
      expect(console.error).toHaveBeenCalledWith('[bridge-auth]', 'msg');
    });

    it('always uses [bridge-auth] as the prefix for debug when enabled', () => {
      const logger = createLogger(true);
      logger.debug('msg');
      expect(console.debug).toHaveBeenCalledWith('[bridge-auth]', 'msg');
    });

    it('always uses [bridge-auth] as the prefix for warn when enabled', () => {
      const logger = createLogger(true);
      logger.warn('msg');
      expect(console.warn).toHaveBeenCalledWith('[bridge-auth]', 'msg');
    });
  });

  describe('multiple arguments', () => {
    it('passes all args through to console.error', () => {
      const logger = createLogger(false);
      const obj = { key: 'value' };
      logger.error('error occurred', obj, 123);
      expect(console.error).toHaveBeenCalledWith('[bridge-auth]', 'error occurred', obj, 123);
    });

    it('passes all args through to console.debug when enabled', () => {
      const logger = createLogger(true);
      logger.debug('a', 'b', 'c');
      expect(console.debug).toHaveBeenCalledWith('[bridge-auth]', 'a', 'b', 'c');
    });
  });
});
