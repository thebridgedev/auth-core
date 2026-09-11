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
 * is a broken product.
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
 * Build a translator.
 *
 * `locale` unknown → English, no throw. That is a deliberate silent fallback:
 * an app passing `locale="klingon"` should still render a usable login form,
 * and a hard failure on the auth screen locks everybody out over a typo.
 */
export function createTranslator(args?: {
  locale?: string | null;
  messages?: MessageOverrides;
}): Translator {
  const { locale, messages } = args ?? {};
  const catalogue: Messages =
    (locale && LOCALES[normalizeLocale(locale)]) || en;

  return (key, vars) => {
    const template = messages?.[key] ?? catalogue[key] ?? en[key];
    return interpolate(template, vars);
  };
}

export type { MessageKey, Messages };
