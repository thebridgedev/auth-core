import { entitlementFlag, ENTITLEMENT_FLAG_PREFIX } from './quota.js';
import type { Flags } from './flags.js';

/**
 * Which plan features the workspace has, as the flags
 * `bridge:billing.entitlement.<key>` Bridge keeps. Built on the flag results
 * the client already holds; it never reads the plan. Off until Bridge says
 * on, as every flag is.
 */
export function createEntitlements(flags: Pick<Flags, 'enabled' | 'all' | 'subscribe'>) {
  const all = (): Record<string, boolean> => {
    const features: Record<string, boolean> = {};
    for (const [flag, result] of flags.all()) {
      if (flag.startsWith(ENTITLEMENT_FLAG_PREFIX) && 'value' in result) features[flag.slice(ENTITLEMENT_FLAG_PREFIX.length)] = result.value === true;
    }
    return features;
  };
  return {
    /** Whether the plan feature `key` is on for this workspace. */
    can: (key: string): boolean => key !== '' && flags.enabled(entitlementFlag(key)),
    /** Every plan feature Bridge gave a result for, `{ key: on }`. */
    all,
    /** Called now and whenever the flag results change. Returns how to stop. */
    subscribe: (listener: (features: Record<string, boolean>) => void): (() => void) => flags.subscribe(() => listener(all())),
  };
}

export type Entitlements = ReturnType<typeof createEntitlements>;
