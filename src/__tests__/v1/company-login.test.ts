import { describe, expect, it } from 'vitest';
import { readCompanyReturn, takeCompanyReturn, type EmailLinkWindow } from '../../sign-in.js';

describe('company login: the answer on the page', () => {
  it('reads a SAML answer (state only), an OpenID Connect one (state and code), an error, and the portal asking to start', () => {
    expect(readCompanyReturn('https://app.acme.test/auth#bridge=company&state=abc')).toEqual({ state: 'abc' });
    expect(readCompanyReturn('#bridge=company&state=abc&code=xyz')).toEqual({ state: 'abc', code: 'xyz' });
    expect(readCompanyReturn('#bridge=company&error=company_login_refused')).toEqual({ error: 'company_login_refused' });
    expect(readCompanyReturn('#bridge=company&error=%3Cscript%3E')).toEqual({ error: 'company_login_refused' });
    expect(readCompanyReturn('#bridge=company-start&connection=6650f0c2a1b2c3d4e5f60718')).toEqual({ start: '6650f0c2a1b2c3d4e5f60718' });
    expect(readCompanyReturn('#bridge=company-start&connection=../evil')).toBeNull();
    expect(readCompanyReturn('#bridge=social&state=abc&code=xyz')).toBeNull();
    expect(readCompanyReturn('#bridge=company')).toBeNull();
  });

  it('takes the answer off the address, so it stays in no history or bookmark', () => {
    let replaced: string | undefined;
    const win: EmailLinkWindow = { location: { hash: '#bridge=company&state=abc', pathname: '/auth', search: '?x=1' }, history: { state: null, replaceState: (_d, _u, url) => (replaced = url) } };
    expect(takeCompanyReturn(win)).toEqual({ state: 'abc' });
    expect(replaced).toBe('/auth?x=1');
  });
});
