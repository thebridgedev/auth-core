import { describe, it, expect } from 'vitest';
import { BridgeAuthError, HttpError } from '../errors.js';

describe('BridgeAuthError', () => {
  it('sets name to BridgeAuthError', () => {
    const err = new BridgeAuthError('something went wrong');
    expect(err.name).toBe('BridgeAuthError');
  });

  it('sets message', () => {
    const err = new BridgeAuthError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('sets code when provided', () => {
    const err = new BridgeAuthError('something went wrong', 'MY_CODE');
    expect(err.code).toBe('MY_CODE');
  });

  it('code is undefined when not provided', () => {
    const err = new BridgeAuthError('something went wrong');
    expect(err.code).toBeUndefined();
  });

  it('is an instance of Error', () => {
    const err = new BridgeAuthError('oops');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of BridgeAuthError', () => {
    const err = new BridgeAuthError('oops');
    expect(err).toBeInstanceOf(BridgeAuthError);
  });
});

describe('HttpError', () => {
  it('sets name to HttpError', () => {
    const err = new HttpError('Not Found', 404);
    expect(err.name).toBe('HttpError');
  });

  it('sets message', () => {
    const err = new HttpError('Not Found', 404);
    expect(err.message).toBe('Not Found');
  });

  it('sets status', () => {
    const err = new HttpError('Not Found', 404);
    expect(err.status).toBe(404);
  });

  it('sets code as HTTP_{status}', () => {
    const err = new HttpError('Not Found', 404);
    expect(err.code).toBe('HTTP_404');
  });

  it('sets code as HTTP_{status} for 500', () => {
    const err = new HttpError('Internal Server Error', 500);
    expect(err.code).toBe('HTTP_500');
  });

  it('sets body when provided', () => {
    const body = { detail: 'resource not found' };
    const err = new HttpError('Not Found', 404, body);
    expect(err.body).toEqual(body);
  });

  it('body is undefined when not provided', () => {
    const err = new HttpError('Not Found', 404);
    expect(err.body).toBeUndefined();
  });

  it('is an instance of BridgeAuthError', () => {
    const err = new HttpError('Unauthorized', 401);
    expect(err).toBeInstanceOf(BridgeAuthError);
  });

  it('is an instance of Error', () => {
    const err = new HttpError('Unauthorized', 401);
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of HttpError', () => {
    const err = new HttpError('Unauthorized', 401);
    expect(err).toBeInstanceOf(HttpError);
  });
});
