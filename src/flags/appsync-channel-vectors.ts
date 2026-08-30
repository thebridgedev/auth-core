// Golden vectors for the AppSync Events channel wire format (TBP-575).
//
// The bug this file exists to prevent: bridge-api published to `/app/<id>`
// while the SDK subscribed to `app/<id>`. Both sides had unit tests, both
// passed, and realtime was dead on production for the entire life of the
// AppSync transport — because each side tested its own half against a mock
// and nothing ever compared the two strings.
//
// This table is the contract. It is duplicated **byte-for-byte** at
//   bridge-api/microservices/shared/realtime/appsync-channel-vectors.ts
// and asserted by tests in both repos. Two packages that ship separately
// cannot import from each other, so the duplication is deliberate: the cost
// is one copied file, the benefit is that drifting either end turns red in
// CI instead of going silent in production.
//
// If you change this file, change the other copy in the same commit.

export interface AppSyncChannelVector {
  /** Internal channel name — the `<ns>:<id>` form used everywhere in code. */
  internal: string;
  /** On-the-wire AppSync Events channel — `/<namespace>/<path>`. */
  wire: string;
}

/**
 * Every channel namespace declared in
 * `nebulr-core/cloudformations/appsync-events/appsync-events-cloudformation-template.yml`.
 *
 * The leading slash is the part that matters: AppSync resolves the channel
 * namespace from the first path segment, so `app/x` addresses nothing.
 */
export const APPSYNC_CHANNEL_VECTORS: readonly AppSyncChannelVector[] = [
  { internal: 'app:6a9469f6a87b8c1113d7e3f5', wire: '/app/6a9469f6a87b8c1113d7e3f5' },
  { internal: 'workspace:ws-1', wire: '/workspace/ws-1' },
  { internal: 'user:u-1', wire: '/user/u-1' },
  { internal: 'integration:6a9469f6a87b8c1113d7e3f5', wire: '/integration/6a9469f6a87b8c1113d7e3f5' },
] as const;
