// @vitest-environment node
//
// The revocation entry format: every field is checked, and anything this
// version does not read fully is refused rather than half understood.
import { describe, expect, it } from 'vitest';
import { parseRevocationCheckpoint, parseRevocationEntry } from '../../verifier/revocation-entry.js';

const base = { v: 1, app: 'app-acme', lane: 'members', seq: 1, at: 1_000 };

describe('revocation entry format', () => {
  it.each([
    ['a token', { kind: 'token', id: 'tok-1' }],
    ['a session', { kind: 'session', id: 'sess-1' }],
    ['a key', { kind: 'key', id: 'key-1' }],
    ['a client', { kind: 'client', id: 'client-1', before: 3_000 }],
    ['a person everywhere', { kind: 'person', id: 'user-1', before: 3_000 }],
    ['a person in one workspace', { kind: 'person', id: 'user-1', workspace: 'ws-1', before: 3_000 }],
    ['a workspace', { kind: 'workspace', id: 'ws-1', before: 3_000 }],
    ['a role in a workspace', { kind: 'role', id: 'ADMIN', workspace: 'ws-1', before: 3_000 }],
    ['a billing version for a workspace', { kind: 'billing', scope: 'workspace', id: 'ws-1', version: 8, before: 3_000 }],
    ['a billing version for the app', { kind: 'billing', scope: 'app', version: 3, before: 3_000 }],
    ['a change of ownership', { kind: 'ownership', id: 'app-shop', before: 3_000 }],
  ])('reads %s', (_name, fields) => {
    expect(parseRevocationEntry({ ...base, ...fields })).toMatchObject({ ...base, ...fields });
  });

  it.each([
    ['another format version', { v: 2, kind: 'token', id: 'tok-1' }],
    ['an unknown kind', { kind: 'everything', id: 'x', before: 3_000 }],
    ['no number', { seq: undefined, kind: 'token', id: 'tok-1' }],
    ['number 0', { seq: 0, kind: 'token', id: 'tok-1' }],
    ['a fractional number', { seq: 1.5, kind: 'token', id: 'tok-1' }],
    ['no app', { app: '', kind: 'token', id: 'tok-1' }],
    ['a token with a cutoff', { kind: 'token', id: 'tok-1', before: 3_000 }],
    ['a person without a cutoff', { kind: 'person', id: 'user-1' }],
    ['a person without an id', { kind: 'person', before: 3_000 }],
    ['a role without a workspace', { kind: 'role', id: 'ADMIN', before: 3_000 }],
    ['a workspace limited to a workspace', { kind: 'workspace', id: 'ws-1', workspace: 'ws-2', before: 3_000 }],
    ['a billing version without a scope', { kind: 'billing', id: 'ws-1', version: 8, before: 3_000 }],
    ['an app-wide billing version naming a workspace', { kind: 'billing', scope: 'app', id: 'ws-1', version: 3, before: 3_000 }],
    ['a billing version of 0', { kind: 'billing', scope: 'app', version: 0, before: 3_000 }],
    ['a version on another kind', { kind: 'person', id: 'user-1', version: 2, before: 3_000 }],
    ['an id that is not text', { kind: 'session', id: 42 }],
  ])('refuses %s', (_name, fields) => {
    expect(parseRevocationEntry({ ...base, ...fields })).toBeNull();
  });

  it('refuses what is not an object', () => {
    for (const value of [null, 'entry', 1, [base]]) expect(parseRevocationEntry(value)).toBeNull();
  });
});

describe('revocation checkpoint format', () => {
  const checkpoint = { v: 1, app: 'app-acme', lane: 'members', head: 12, floor: 5, floorAt: 2_000, at: 9_000 };

  it.each([
    ['a lane that dropped its oldest entries', checkpoint],
    ['a lane that never dropped one', { ...checkpoint, floor: 1, floorAt: 0 }],
    ['an empty lane', { ...checkpoint, head: 0, floor: 1, floorAt: 0 }],
    ['a lane that keeps no entry any more', { ...checkpoint, head: 12, floor: 13 }],
  ])('reads %s', (_name, fields) => {
    expect(parseRevocationCheckpoint(fields)).toEqual(fields);
  });

  it.each([
    ['another format version', { v: 2 }],
    ['no lane', { lane: '' }],
    ['a negative head', { head: -1 }],
    ['a floor of 0', { floor: 0 }],
    ['a floor above the head plus one', { floor: 14 }],
    ['a fractional floor', { floor: 1.5 }],
    ['no floor time', { floorAt: undefined }],
    ['no signing time', { at: undefined }],
    ['a head that is text', { head: '12' }],
  ])('refuses %s', (_name, fields) => {
    expect(parseRevocationCheckpoint({ ...checkpoint, ...fields })).toBeNull();
  });
});
