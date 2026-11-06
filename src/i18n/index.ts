/**
 * @nebulr-group/bridge-auth-core/i18n
 *
 * The words the sign-in screens show, in twelve languages, for every
 * framework plugin to share.
 */
export { da, de, en, es, fi, fr, it, LOCALES, nb, nl, pl, pt, sv } from './messages.js';
export { createTranslator, hasLocale, interpolate, normalizeLocale, resetMissingLocaleWarnings } from './resolver.js';
export type { MessageKey, MessageOverrides, Messages, Translator } from './resolver.js';
