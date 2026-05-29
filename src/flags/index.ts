export {
  OPERATORS,
  OPERATOR_VERSION,
  CONDITIONS_PER_RULE_MAX,
  isOperator,
  isOperatorValidForType,
  validOperatorsForType,
  evaluateCondition,
  validateConditions,
} from './operators.js';

export type {
  Operator,
  AttributeType,
  Condition,
  ConditionValue,
  ValidationError,
} from './operators.js';

// Rule + branches + evaluator (TBP-160, TBP-158)
export {
  bucket,
  evaluateBranch,
  evaluateRule,
  resolveAttribute,
  validateRule,
} from './evaluator.js';

export type {
  Branch,
  Rule,
  FlagState,
  EvalContext,
  EvalResult,
  RuleValidationError,
} from './evaluator.js';

// SDK API: bridge.flag(key, default) with type inference (TBP-160)
export { BridgeFlags } from './flag.js';
export type {
  CachedFlag,
  FlagEvalResult,
  FlagValueType,
  EvalTelemetry,
  DiscoveryTelemetry,
  BridgeFlagsHooks,
  DeclaredAttributeType,
  AttributeDeclaration,
  BridgeFlagsMode,
  FlagUsageReporterLike,
} from './flag.js';

// Identity: anonymous ID + `identify` (TBP-168, TBP-169)
export {
  BridgeIdentity,
  MemoryIdentityStorage,
  attachIdentity,
  generateAnonymousId,
} from './identity.js';
export type {
  AnonymousTrackingMode,
  IdentityStorage,
} from './identity.js';

// AttributeProvider plugin model (TBP-173)
export {
  AttributeProviderRegistry,
  AuthAttributeProvider,
  BillingAttributeProvider,
} from './attribute-providers.js';
export type {
  AttributeProvider,
  AuthJwtClaims,
  AuthProviderConfig,
  BillingSnapshot,
  BillingProviderConfig,
  BillingProviderStores,
} from './attribute-providers.js';

// Phase 5 (TBP-328/329/330) — dev-managed AttributeProvider backing the
// `bridge.attributes` write surface in framework SDKs.
export { DevAttributeProvider } from './dev-attribute-provider.js';
export type {
  AttributeGetter,
  AttributeBulkGetter,
  SetOptions as AttributesSetOptions,
} from './dev-attribute-provider.js';

// Phase 6 (TBP-290/340) — runtime mode + pull-mode cache for backend SDKs.
export { BridgePullCache } from './runtime-mode.js';
export type { BridgeRuntimeMode, PullCacheOptions } from './runtime-mode.js';

// SDK telemetry batcher (TBP-157)
export { TelemetryBatcher } from './telemetry.js';
export type { TelemetryBatcherConfig } from './telemetry.js';

// SDK realtime client (TBP-150)
export { RealtimeClient } from './realtime.js';
export type {
  RealtimeClientConfig,
  RealtimeMessage,
  FlagUpdateMessage,
  FlagRemovedMessage,
  UserStateMessage,
  SubscriptionPlanChangedMessage,
  BillingLifecycleMessage,
  QuotaUpdatedMessage,
  EntitlementsChangedMessage,
  SessionSnapshotMessage,
  ConnectionState,
  WebSocketLike,
} from './realtime.js';

// FE → BE context propagation (TBP-171) + server-instance ID (TBP-172)
export {
  BRIDGE_CONTEXT_HEADER,
  serializeContext,
  deserializeContext,
  serverInstanceId,
} from './propagation.js';
