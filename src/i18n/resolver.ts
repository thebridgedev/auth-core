import { en, LOCALES, type MessageKey, type Messages } from './messages.js';

/**
 * Message resolution for the SDK auth components (TBP-630).
 *
 * ## Synchronous, deliberately
 *
 * These components render during an auth redirect. An async catalogue load
 * would paint English first and then swap — a visible flash on the one screen
 * where the user is already waiting and already unsure. So every locale is
 * bundled and lookup is a property access. The catalogue is small enough that
 * this is cheaper than the machinery to avoid it.
 *
 * ## Resolution order
 *
 *   1. explicit per-key `messages` override
 *   2. requested `locale`
 *   3. English
 *
 * A missing key falls through to English, and a raw key NEVER renders. If the
 * catalogue is wrong, the user sees the wrong language; if it rendered keys,
 * they would see `login.submit` on a button. The first is a defect, the second
 * is a broken product. This matches every mainstream i18n library: a missing
 * LOCALE renders the fallback language, never the key.
 *
 * ## The fallback is silent to users and loud to developers
 *
 * Falling back quietly is right for the person signing in and wrong for the
 * person who configured it. An app that sets `locale: 'de'` today gets English,
 * no error, nothing in the UI to notice — which is exactly how a consumer
 * shipping twelve languages discovered ten of them were English only after
 * release (TBP-633).
 *
 * So the fallback warns on the console, once per locale, in non-production
 * builds. Also standard: react-intl, vue-i18n and i18next all warn in dev and
 * go quiet in prod. Production stays silent because a warning nobody is reading
 * is just noise in a real user's console.
 */
export type MessageOverrides = Partial<Record<MessageKey, string>>;

export interface Translator {
  /** Resolve a key, substituting `{name}` placeholders from `vars`. */
  (key: MessageKey, vars?: Record<string, string | number>): string;
}

/**
 * Substitute `{name}` placeholders.
 *
 * A variable with no matching value is left as its literal placeholder rather
 * than rendered as `undefined`. Neither is good, but `{email}` reads as
 * obviously-missing data while `undefined` reads as a crash.
 *
 * Word order is the translator's business: the whole string is translated with
 * the placeholder in it, so a locale that needs the variable first simply moves
 * it. Nothing here concatenates fragments.
 */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** True when the locale has a catalogue. Consumers can use this to warn early. */
export function hasLocale(locale: string | null | undefined): boolean {
  return !!locale && !!LOCALES[normalizeLocale(locale)];
}

/**
 * `sv-SE` → `sv`. Region variants share a catalogue until somebody has a reason
 * to split them; matching `navigator.language` exactly would mean `en-GB` users
 * falling back to... English, and `sv-SE` users falling back to English too,
 * which is the bug.
 */
export function normalizeLocale(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0];
}

/**
 * True in a development build.
 *
 * Guarded rather than read directly: this package runs in browsers, workers and
 * SSR, and `process` does not exist in all of them. An unbundled browser with no
 * `process` is treated as development, which is the safer default — a missing
 * warning is worse than an extra one.
 */
function isDevelopment(): boolean {
  try {
    return typeof process === 'undefined' || process.env?.NODE_ENV !== 'production';
  } catch {
    return true;
  }
}

/**
 * Locales and keys already warned about.
 *
 * Deduping is not a nicety. React rebuilds a translator on every render and the
 * Angular binding builds one PER KEY per change-detection pass, so an
 * undeduplicated warning would emit thousands of identical lines behind a single
 * login form and bury whatever else was in the console.
 */
const warned = new Set<string>();

function warnOnce(id: string, message: string): void {
  if (!isDevelopment()) return;
  if (warned.has(id)) return;
  warned.add(id);
  // Deliberately `console.warn` and not the package logger: that logger gates
  // `warn` behind `debug: true`, so the one consumer who most needs this — the
  // one who does not yet know a locale is missing — would never see it.
  console.warn(`[bridge-auth] ${message}`);
}

/** Clear the warn-once memory. Test-only; a suite asserting on warnings needs
 *  each case to start from silence. */
export function resetMissingLocaleWarnings(): void {
  warned.clear();
}

/**
 * Build a translator.
 *
 * `locale` unknown → English, no throw. That is a deliberate silent-to-users
 * fallback: an app passing `locale="klingon"` should still render a usable login
 * form, and a hard failure on the auth screen locks everybody out over a typo.
 * The console warning is how the developer finds out.
 */
export function createTranslator(args?: {
  locale?: string | null;
  messages?: MessageOverrides;
}): Translator {
  const { locale, messages } = args ?? {};

  const requested = locale ? normalizeLocale(locale) : null;
  const resolved = requested ? LOCALES[requested] : undefined;
  const catalogue: Messages = resolved || en;

  if (requested && !resolved) {
    // One line says everything there is to say: for an unknown locale EVERY
    // string is English, so there is no per-key detail worth enumerating.
    warnOnce(
      `locale:${requested}`,
      `locale "${locale}" has no catalogue — falling back to English. ` +
        `Available: ${Object.keys(LOCALES).sort().join(', ')}.`,
    );
  }

  return (key, vars) => {
    const override = messages?.[key];
    if (override !== undefined) return interpolate(override, vars);

    const fromLocale = catalogue[key];
    if (fromLocale === undefined) {
      // Only reachable for a catalogue built at runtime — `Messages` requires
      // every key, so the shipped ones cannot get here. Warned anyway, because
      // this is the case where the fallback is genuinely partial and a reader
      // would otherwise see one English sentence in an otherwise translated form.
      warnOnce(
        `key:${requested ?? 'en'}:${key}`,
        `key "${key}" is missing from locale "${requested ?? 'en'}" — falling back to English.`,
      );
      return interpolate(en[key], vars);
    }

    return interpolate(fromLocale, vars);
  };
}

export type { MessageKey, Messages };
