import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  da,
  de,
  en,
  es,
  fi,
  fr,
  it as itLocale,
  nb,
  nl,
  pl,
  pt,
  sv,
  LOCALES,
  type MessageKey,
  type Messages,
} from '../i18n/messages.js';
import {
  createTranslator,
  hasLocale,
  interpolate,
  resetMissingLocaleWarnings,
  normalizeLocale,
} from '../i18n/resolver.js';

// TBP-630 — the SDK auth components render fixed English copy. These tests hold
// the resolver's one non-negotiable promise: a raw key (`login.submit`) must
// NEVER reach a button. Every fallback rung therefore asserts the actual
// resolved STRING, never merely "did not throw" or "is defined" — a resolver
// that returned the key for everything would satisfy those and ship a broken
// login screen.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Three distinct renderings of ONE key, so each rung of the resolution chain is
 * distinguishable in the output. If English and Swedish shared a string, a
 * resolver that ignored `locale` entirely would still pass.
 */
const PROBE_KEY: MessageKey = 'login.submit';
const EN_PROBE = 'Sign in';
const SV_PROBE = 'Logga in';
const OVERRIDE_PROBE = 'Enter the workspace';

/** A second key, used to prove a fallback is per-key and not blanket-English. */
const SECOND_KEY: MessageKey = 'login.forgotPassword';
const EN_SECOND = 'Forgot password?';
const SV_SECOND = 'Glömt lösenordet?';

/**
 * `placeholder.phoneNumber` is deliberately empty in every locale: it used to
 * carry the US format `+1 (555) 000-0000`, shown to European workspaces, and a
 * hint that is wrong for most of the audience is worse than no hint. It is the
 * ONLY key allowed to be empty — everything else empty is a shipping defect.
 */
const ALLOWED_EMPTY = new Set<MessageKey>(['placeholder.phoneNumber']);

/** Keys whose copy carries `{email}` — dropping it silently loses the address. */
const EMAIL_INTERPOLATED: MessageKey[] = [
  'signup.successDescription',
  'passkey.sentDescription',
];

const ALL_KEYS = Object.keys(en) as MessageKey[];

/**
 * Every catalogue the package claims to ship, named individually.
 *
 * Deliberately NOT `Object.entries(LOCALES)`: the point of these tests is to
 * catch a locale that was exported but never registered, or registered under
 * the wrong key. Derived from LOCALES they would agree with themselves.
 *
 * `it` collides with vitest's `it`, hence the alias on the import.
 */
const SHIPPED: Record<string, Messages> = {
  da,
  de,
  en,
  es,
  fi,
  fr,
  it: itLocale,
  nb,
  nl,
  pl,
  pt,
  sv,
};

/**
 * Two codes that are NOT in `LOCALES`, used everywhere a test needs "a locale
 * the package does not have".
 *
 * They are invented rather than real-but-unshipped (`de`, `fr`) on purpose:
 * TBP-632 shipped ten more languages and every test that had borrowed a real
 * code as its stand-in for "unknown" started failing, because the stand-in had
 * become known. An invented code cannot be overtaken by the next locale.
 * `assertUnshipped` below fails loudly if one ever is.
 */
const UNSHIPPED_A = 'klingon';
const UNSHIPPED_B = 'dothraki';

/** Locale name registered by tests that need a deliberately incomplete catalogue. */
const SYNTHETIC = 'zz';

/**
 * Register a partial catalogue under `SYNTHETIC`. `LOCALES` is a plain record,
 * so this is how a half-finished locale (TBP-632's ten follow-up languages)
 * would actually look at runtime. Removed again in `afterEach`.
 */
function registerPartialLocale(partial: Partial<Messages>): void {
  LOCALES[SYNTHETIC] = partial as Messages;
}

afterEach(() => {
  delete LOCALES[SYNTHETIC];
});

// ---------------------------------------------------------------------------
// 1. Resolution order: override → locale → English
// ---------------------------------------------------------------------------

describe('createTranslator — resolution order', () => {
  it('falls back to English when no locale is given', () => {
    const t = createTranslator({});
    expect(t(PROBE_KEY)).toBe(EN_PROBE);
    expect(t(SECOND_KEY)).toBe(EN_SECOND);
  });

  it('uses the requested locale when one is given', () => {
    const t = createTranslator({ locale: 'sv' });
    expect(t(PROBE_KEY)).toBe(SV_PROBE);
    expect(t(SECOND_KEY)).toBe(SV_SECOND);
  });

  it('lets an explicit override beat English', () => {
    const t = createTranslator({ messages: { [PROBE_KEY]: OVERRIDE_PROBE } });
    expect(t(PROBE_KEY)).toBe(OVERRIDE_PROBE);
    // Paired positive: the un-overridden key still resolves normally, so the
    // override is per-key and not a whole-catalogue replacement.
    expect(t(SECOND_KEY)).toBe(EN_SECOND);
  });

  it('lets an explicit override beat the requested locale', () => {
    const t = createTranslator({
      locale: 'sv',
      messages: { [PROBE_KEY]: OVERRIDE_PROBE },
    });
    expect(t(PROBE_KEY)).toBe(OVERRIDE_PROBE);
    expect(t(SECOND_KEY)).toBe(SV_SECOND);
  });

  it('ranks all three rungs in one translator: override > locale > English', () => {
    // The partial locale supplies SECOND_KEY only, so a single translator
    // exercises every rung at once and the ordering is visible in one assertion.
    registerPartialLocale({ [SECOND_KEY]: 'synthetic forgot' });
    const t = createTranslator({
      locale: SYNTHETIC,
      messages: { [PROBE_KEY]: OVERRIDE_PROBE },
    });

    expect(t(PROBE_KEY)).toBe(OVERRIDE_PROBE); // rung 1: override
    expect(t(SECOND_KEY)).toBe('synthetic forgot'); // rung 2: locale
    expect(t('login.heading')).toBe(en['login.heading']); // rung 3: English
  });

  it('interpolates whichever rung won', () => {
    const overridden = createTranslator({
      messages: { 'signup.successDescription': 'Link sent to {email}.' },
    });
    expect(overridden('signup.successDescription', { email: 'a@b.test' })).toBe(
      'Link sent to a@b.test.',
    );

    const swedish = createTranslator({ locale: 'sv' });
    expect(swedish('signup.successDescription', { email: 'a@b.test' })).toContain(
      'a@b.test',
    );
    expect(swedish('signup.successDescription', { email: 'a@b.test' })).not.toContain(
      '{email}',
    );
  });

  it('works with no arguments at all and returns English', () => {
    const t = createTranslator();
    expect(t(PROBE_KEY)).toBe(EN_PROBE);
    expect(t('mfaSetup.heading')).toBe(en['mfaSetup.heading']);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing key inside a known locale → the English STRING
// ---------------------------------------------------------------------------

describe('createTranslator — missing key in a known locale', () => {
  it('returns the English string, not the key and not empty', () => {
    registerPartialLocale({ [PROBE_KEY]: 'synthetic sign in' });
    const t = createTranslator({ locale: SYNTHETIC });

    // Present in the partial catalogue → the locale wins.
    expect(t(PROBE_KEY)).toBe('synthetic sign in');
    // Absent → English, verbatim.
    expect(t(SECOND_KEY)).toBe(EN_SECOND);
    expect(t(SECOND_KEY)).not.toBe(SECOND_KEY);
    expect(t(SECOND_KEY)).not.toBe('');
  });

  it('falls through to English for EVERY key an incomplete locale is missing', () => {
    registerPartialLocale({ [PROBE_KEY]: 'synthetic sign in' });
    const t = createTranslator({ locale: SYNTHETIC });

    for (const key of ALL_KEYS) {
      if (key === PROBE_KEY) continue;
      expect(t(key)).toBe(en[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown locale → English, never a throw
// ---------------------------------------------------------------------------

describe('createTranslator — unknown locale', () => {
  const UNKNOWN: Array<{ label: string; locale: string | null | undefined }> = [
    { label: 'an invented language', locale: UNSHIPPED_A },
    { label: 'empty string', locale: '' },
    { label: 'null', locale: null },
    { label: 'undefined', locale: undefined },
    { label: 'whitespace', locale: '   ' },
    { label: 'region of an unknown language', locale: `${UNSHIPPED_A}-KX` },
  ];

  for (const { label, locale } of UNKNOWN) {
    it(`renders English for ${label}`, () => {
      const t = createTranslator({ locale });
      expect(t(PROBE_KEY)).toBe(EN_PROBE);
      expect(t(SECOND_KEY)).toBe(EN_SECOND);
      // The same mechanism must still be able to pick a non-English catalogue —
      // otherwise "always English" would pass this table for the wrong reason.
      expect(createTranslator({ locale: 'sv' })(PROBE_KEY)).toBe(SV_PROBE);
    });
  }

  it('renders a full, key-free login screen for an unknown locale', () => {
    const t = createTranslator({ locale: UNSHIPPED_A });
    for (const key of ALL_KEYS) {
      expect(t(key)).toBe(en[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. normalizeLocale
// ---------------------------------------------------------------------------

describe('normalizeLocale', () => {
  const CASES: Array<[string, string]> = [
    ['sv-SE', 'sv'],
    ['SV', 'sv'],
    ['de_AT', 'de'],
    ['en-GB', 'en'],
    ['sv', 'sv'],
    ['EN_us', 'en'],
    ['pt-BR', 'pt'],
  ];

  for (const [input, expected] of CASES) {
    it(`${input} → ${expected}`, () => {
      expect(normalizeLocale(input)).toBe(expected);
    });
  }

  it('drives catalogue selection: a region variant resolves its base language', () => {
    expect(createTranslator({ locale: 'sv-SE' })(PROBE_KEY)).toBe(SV_PROBE);
    expect(createTranslator({ locale: 'SV' })(PROBE_KEY)).toBe(SV_PROBE);
    expect(createTranslator({ locale: 'en-GB' })(PROBE_KEY)).toBe(EN_PROBE);
  });
});

// ---------------------------------------------------------------------------
// 5. hasLocale
// ---------------------------------------------------------------------------

describe('hasLocale', () => {
  const KNOWN = ['en', 'sv', 'sv-SE', 'SV', 'en-GB', 'sv_FI'];
  const UNKNOWN: Array<string | null | undefined> = [
    UNSHIPPED_A,
    UNSHIPPED_B,
    `${UNSHIPPED_A}-KX`,
    '',
    '   ',
    null,
    undefined,
  ];

  for (const locale of KNOWN) {
    it(`true for ${locale}`, () => {
      expect(hasLocale(locale)).toBe(true);
      // Paired positive: a locale it claims to have really does translate.
      expect(createTranslator({ locale })(PROBE_KEY)).toBe(
        normalizeLocale(locale) === 'sv' ? SV_PROBE : EN_PROBE,
      );
    });
  }

  for (const locale of UNKNOWN) {
    it(`false for ${JSON.stringify(locale)}`, () => {
      expect(hasLocale(locale)).toBe(false);
      // ...and the unknown locale still renders English copy rather than keys.
      expect(createTranslator({ locale })(PROBE_KEY)).toBe(EN_PROBE);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. interpolate
// ---------------------------------------------------------------------------

describe('interpolate', () => {
  it('substitutes a named variable', () => {
    expect(interpolate('Sent to {email}.', { email: 'a@b.test' })).toBe(
      'Sent to a@b.test.',
    );
  });

  it('leaves an unsupplied variable as its literal placeholder, never undefined', () => {
    const out = interpolate('Sent to {email}.', { other: 'x' });
    expect(out).toBe('Sent to {email}.');
    expect(out).not.toContain('undefined');
  });

  it('leaves every placeholder literal when vars is omitted entirely', () => {
    expect(interpolate('Expires in {expiry}.')).toBe('Expires in {expiry}.');
    expect(interpolate('Expires in {expiry}.', undefined)).toBe('Expires in {expiry}.');
  });

  it('returns a var-free template untouched, with or without vars', () => {
    expect(interpolate('Sign in')).toBe('Sign in');
    expect(interpolate('Sign in', { email: 'a@b.test' })).toBe('Sign in');
  });

  it('substitutes numbers', () => {
    expect(interpolate('{count} minutes', { count: 5 })).toBe('5 minutes');
    expect(interpolate('resend in {seconds}s', { seconds: 0 })).toBe('resend in 0s');
  });

  it('substitutes a supplied empty string rather than keeping the placeholder', () => {
    // Presence is decided by `in`, not truthiness — an intentionally blank value
    // must not be mistaken for a missing one.
    expect(interpolate('a{x}b', { x: '' })).toBe('ab');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    expect(interpolate('{name} and {name} and {other}', { name: 'A', other: 'B' })).toBe(
      'A and A and B',
    );
  });

  it('mixes supplied and unsupplied placeholders in one template', () => {
    expect(interpolate('{a} {b} {a}', { a: 'x' })).toBe('x {b} x');
  });

  it('does not treat unmatched braces as placeholders', () => {
    expect(interpolate('{ not a var }', { not: 'x' })).toBe('{ not a var }');
    expect(interpolate('100% {sure}', {})).toBe('100% {sure}');
  });
});

// ---------------------------------------------------------------------------
// 7. Catalogue parity — the guard against a half-finished locale (TBP-632)
// ---------------------------------------------------------------------------

describe('catalogue parity', () => {
  const localeNames = Object.keys(LOCALES);

  it('ships the locales it claims to ship', () => {
    // TBP-632 took this from two to twelve. The list is spelled out rather than
    // derived from LOCALES so that dropping a locale is a test failure and not
    // a silently shorter loop.
    expect(localeNames.slice().sort()).toEqual([
      'da', 'de', 'en', 'es', 'fi', 'fr', 'it', 'nb', 'nl', 'pl', 'pt', 'sv',
    ]);
    for (const [name, catalogue] of Object.entries(SHIPPED)) {
      expect(LOCALES[name]).toBe(catalogue);
    }
  });

  for (const name of Object.keys(SHIPPED)) {
    it(`${name} has exactly the same key set as en`, () => {
      const keys = Object.keys(LOCALES[name]).sort();
      const enKeys = ALL_KEYS.slice().sort();
      // Same set in BOTH directions: no key missing, no key invented.
      expect(keys).toEqual(enKeys);
    });

    it(`${name} has a non-empty string for every key except the allowed-empty one`, () => {
      const catalogue = LOCALES[name];
      for (const key of ALL_KEYS) {
        const value = catalogue[key];
        expect(typeof value).toBe('string');
        if (ALLOWED_EMPTY.has(key)) continue;
        expect(value.trim()).not.toBe('');
        // A catalogue that echoed its keys would satisfy "non-empty".
        expect(value).not.toBe(key);
      }
    });
  }

  it('keeps the click-to-start passkey copy distinct from the in-flight copy', () => {
    // TBP-633 — react/angular/nextjs raise the browser ceremony on a click, so
    // their setup screen sits idle until the user acts; svelte starts it on
    // mount. `setupDescription` narrates a ceremony already running ("follow the
    // prompt from your browser"), which is wrong on a screen where no prompt has
    // been raised. The keys exist to say different things, so a locale that
    // collapses them back to one sentence has undone the fix.
    for (const name of localeNames) {
      expect(LOCALES[name]['passkey.setupClickPrompt']).not.toBe(
        LOCALES[name]['passkey.setupDescription'],
      );
      expect(LOCALES[name]['passkey.setupSubmit']).not.toBe(
        LOCALES[name]['passkey.setupDescription'],
      );
    }
  });

  it('keeps placeholder.phoneNumber empty in every locale', () => {
    // Regression: the US format `+1 (555) 000-0000` was shown to every European
    // workspace (TBP-630). No hint beats a wrong hint; the field has a label.
    for (const name of localeNames) {
      expect(LOCALES[name]['placeholder.phoneNumber']).toBe('');
    }
  });

  for (const name of Object.keys(SHIPPED)) {
    if (name === 'en') continue;
    it(`translates rather than copies: ${name} differs from en on most keys`, () => {
      // Parity alone would pass for `de = { ...en }` — a locale that is
      // registered, complete, type-correct and entirely untranslated. That is
      // the exact shape a hurried tenth locale would take, so demand that the
      // strings actually differ. The handful that legitimately match are the
      // empty phone placeholder and, in a few languages, a unit word that is
      // spelled the same ("{count} minute" in French).
      const differing = ALL_KEYS.filter((key) => LOCALES[name][key] !== en[key]);
      expect(differing.length).toBeGreaterThan(ALL_KEYS.length * 0.8);
    });
  }

  it('the "unknown locale" fixtures really are unknown', () => {
    // Load-bearing for every test that uses them. When locale thirteen arrives,
    // this is the assertion that says "your new code collided with the fixture"
    // instead of six unrelated tests failing for a reason nobody can read.
    for (const code of [UNSHIPPED_A, UNSHIPPED_B]) {
      expect(localeNames).not.toContain(code);
      expect(hasLocale(code)).toBe(false);
    }
  });

  it('does not ship the same catalogue twice under two names', () => {
    // Two locales that are string-for-string identical means one of them was
    // pasted and never translated.
    const seen = new Map<string, string>();
    for (const name of localeNames) {
      const fingerprint = ALL_KEYS.map((key) => LOCALES[name][key]).join('\u0000');
      const previous = seen.get(fingerprint);
      expect(previous, `${name} is identical to ${previous}`).toBeUndefined();
      seen.set(fingerprint, name);
    }
  });

  it('never renders a raw key, in any locale, known or unknown', () => {
    for (const locale of [...localeNames, 'sv-SE', 'klingon', '', null, undefined]) {
      const t = createTranslator({ locale });
      for (const key of ALL_KEYS) {
        const rendered = t(key);
        expect(typeof rendered).toBe('string');
        expect(rendered).not.toBe(key);
        expect(rendered).not.toContain('undefined');
        if (!ALLOWED_EMPTY.has(key)) expect(rendered.trim()).not.toBe('');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Interpolated copy keeps its placeholder in every locale
// ---------------------------------------------------------------------------

describe('interpolated copy', () => {
  for (const key of EMAIL_INTERPOLATED) {
    for (const name of Object.keys(SHIPPED)) {
      it(`${name} keeps {email} in ${key}`, () => {
        expect(LOCALES[name][key]).toContain('{email}');
      });
    }

    it(`${key} renders the address, not the placeholder, in every locale`, () => {
      for (const name of Object.keys(LOCALES)) {
        const rendered = createTranslator({ locale: name })(key, {
          email: 'user@example.test',
        });
        expect(rendered).toContain('user@example.test');
        expect(rendered).not.toContain('{email}');
      }
    });
  }

  it('keeps the other documented placeholders too', () => {
    for (const name of Object.keys(LOCALES)) {
      const catalogue = LOCALES[name];
      expect(catalogue['magicLink.sent']).toContain('{expiry}');
      expect(catalogue['magicLink.expiryMinute']).toContain('{count}');
      expect(catalogue['magicLink.expiryMinutes']).toContain('{count}');
      expect(catalogue['magicLink.expirySeconds']).toContain('{count}');
      expect(catalogue['mfa.resendCountdown']).toContain('{seconds}');
    }
  });
});

// ---------------------------------------------------------------------------

describe('missing-locale warning (TBP-633)', () => {
  let warnings: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    resetMissingLocaleWarnings();
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    resetMissingLocaleWarnings();
  });

  it('warns that an unknown locale fell back, naming what IS available', () => {
    createTranslator({ locale: UNSHIPPED_A });

    expect(warnings).toHaveLength(1);
    // The three facts a reader needs: which locale, what happened, what to do.
    expect(warnings[0]).toContain(`"${UNSHIPPED_A}"`);
    expect(warnings[0]).toContain('falling back to English');
    // The "what to do" half is the list of real locales — and it has to be the
    // CURRENT list, not a snapshot, or it stops being actionable the moment a
    // locale is added.
    for (const name of Object.keys(SHIPPED)) {
      expect(warnings[0]).toContain(name);
    }
  });

  it('still renders English — the warning does not change what the user sees', () => {
    // The whole point of warning instead of throwing or rendering keys: the
    // person signing in is unaffected.
    const t = createTranslator({ locale: UNSHIPPED_A });
    expect(t('login.submit')).toBe(en['login.submit']);
  });

  it('warns ONCE per locale, however many translators are built', () => {
    // React rebuilds a translator every render and the Angular binding builds
    // one per key per change-detection pass. Undeduplicated this is thousands of
    // identical lines behind one login form.
    for (let i = 0; i < 500; i++) createTranslator({ locale: UNSHIPPED_A });
    expect(warnings).toHaveLength(1);
  });

  it('warns separately for each distinct unknown locale', () => {
    createTranslator({ locale: UNSHIPPED_A });
    createTranslator({ locale: UNSHIPPED_B });
    createTranslator({ locale: UNSHIPPED_A });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(`"${UNSHIPPED_A}"`);
    expect(warnings[1]).toContain(`"${UNSHIPPED_B}"`);
  });

  it('says nothing for a locale that exists', () => {
    createTranslator({ locale: 'sv' });
    createTranslator({ locale: 'en' });
    expect(warnings).toEqual([]);
  });

  it('says nothing for a region variant that resolves', () => {
    // sv-SE → sv is a hit, not a fallback. Warning here would train people to
    // ignore the warning.
    const t = createTranslator({ locale: 'sv-SE' });
    expect(t('login.submit')).toBe(sv['login.submit']);
    expect(warnings).toEqual([]);
  });

  it('says nothing when no locale is requested at all', () => {
    // Omitting `locale` is not a mistake — it is the documented default.
    createTranslator();
    createTranslator({ messages: { 'login.submit': 'x' } });
    expect(warnings).toEqual([]);
  });

  it('warns once per missing key in a runtime-built catalogue, and renders English', () => {
    // Not reachable through the shipped catalogues — `Messages` requires every
    // key — but it is the case where the fallback is genuinely partial.
    const partial = { 'login.submit': 'Logga in' } as unknown as Messages;
    (LOCALES as Record<string, Messages>).partialtest = partial;
    try {
      const t = createTranslator({ locale: 'partialtest' });
      expect(t('login.submit')).toBe('Logga in');
      expect(warnings).toEqual([]);

      expect(t('login.heading')).toBe(en['login.heading']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"login.heading"');

      t('login.heading');
      expect(warnings).toHaveLength(1);
    } finally {
      delete (LOCALES as Record<string, Messages>).partialtest;
    }
  });

  it('does not warn for a per-key override — that is the documented escape hatch', () => {
    const t = createTranslator({ messages: { 'login.submit': 'Anything' } });
    expect(t('login.submit')).toBe('Anything');
    expect(warnings).toEqual([]);
  });

  it('stays silent in a production build', () => {
    // A warning nobody is reading is noise in a real user's console. Matches
    // react-intl / vue-i18n / i18next, which all go quiet in prod.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      createTranslator({ locale: UNSHIPPED_A });
      expect(warnings).toEqual([]);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
