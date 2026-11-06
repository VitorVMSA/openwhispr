import type { UsageState } from "../lib/usageStore";

/**
 * This build includes connectors without a paid plan. The arguments stay so
 * callers (the chat, including a voice window that only has the persisted
 * flag) keep one eligibility check; signing in and org policy are separate.
 */
export function hasConnectorPlan(_usage: UsageState, _isSubscribedFlag: boolean): boolean {
  return true;
}
