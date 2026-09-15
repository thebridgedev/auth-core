// TBP-675 — the published live-updates troubleshooting page, as the SDK's
// links see it.
//
// The page is NOT in this repo. It lives in bridge-web
// (gitlab.com/nebulrgroup/bridge/bridge-web), at
// `bridge-docs/src/content/docs/live-updates/troubleshooting.mdx`, and is
// published by bridge-web's `deploy_prod` job on `main`. Every `### <code>`
// heading there becomes the anchor `#<code>`.
//
// This list is the contract between the two repos: realtime-docs-anchors.test.ts
// fails when the SDK can emit a reason that is not listed here. When it does,
// add an entry for the reason to the page in bridge-web FIRST, then add the
// anchor here. Run the test with BRIDGE_DOCS_LIVE_CHECK=1 to check this list
// against the live page.

/** The page every realtime reason links to. */
export const TROUBLESHOOTING_PAGE_URL = 'https://thebridge.dev/docs/live-updates/troubleshooting/';

/** Anchors (`### <code>` headings) published on the page. */
export const TROUBLESHOOTING_ANCHORS: readonly string[] = [
  // Your app
  'no_token',
  'expired',
  'malformed',
  'not_yet_valid',
  'workspace_mismatch',
  'user_mismatch',
  'app_mismatch',
  'aud_missing_app',
  'role_not_admin',
  'unknown_channel',
  'api_token_scope',
  'api_token_inactive',
  // Your configuration
  'wrong_environment',
  'wrong_app',
  'issuer_mismatch',
  'origin_not_allowed',
  // Bridge's side
  'refused',
  'anonymous_refused',
  'signature_invalid',
  'alg_mismatch',
  'key_config',
  'unknown',
  // Connection
  'connection_lost',
  'server_error',
  'setup_failed',
  'no_channel_accepted',
];

/**
 * Reasons Bridge itself can send: `/realtime/diagnose` verdicts (relayed
 * verbatim into `status.reason` / `docsUrl`) and the AppSync authorizer's
 * denial codes. Copied from bridge-api `microservices/shared/realtime/`:
 *   realtime-token-diagnosis.ts  VerifyFailureReason, ChannelDenialReason
 *   realtime-diagnose.service.ts `wrong_app`
 *   appsync-authorizer.ts        `api_token_inactive`
 * A new server reason belongs here AND on the page.
 */
export const BRIDGE_SERVER_REASONS: readonly string[] = [
  // VerifyFailureReason
  'expired',
  'not_yet_valid',
  'issuer_mismatch',
  'signature_invalid',
  'alg_mismatch',
  'malformed',
  'key_config',
  'unknown',
  // ChannelDenialReason
  'unknown_channel',
  'origin_not_allowed',
  'no_token',
  'aud_missing_app',
  'workspace_mismatch',
  'user_mismatch',
  'app_mismatch',
  'role_not_admin',
  'api_token_scope',
  // diagnose-only / authorizer-only
  'wrong_app',
  'api_token_inactive',
];
