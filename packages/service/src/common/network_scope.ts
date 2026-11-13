import { AsyncLocalStorage } from 'node:async_hooks';
import {
  allowNetwork,
  dataSaverBehaviorDefaults,
  type DataSaverBehavior,
  type NetworkIntent,
  type NetworkResource,
} from './data_saver';
export const networkScope = new AsyncLocalStorage<{
  restricted: boolean;
  intent: NetworkIntent;
  clientId?: string;
  override?: boolean;
  resource?: NetworkResource;
}>();
let backgroundRestricted = false;
let behavior = { ...dataSaverBehaviorDefaults };
export function transferBehavior(): DataSaverBehavior {
  return behavior;
}
export function setBackgroundNetworkRestriction(
  value: boolean,
  preferences: Partial<DataSaverBehavior> = {},
) {
  backgroundRestricted = value;
  behavior = { ...dataSaverBehaviorDefaults, ...preferences };
}
export function scopedNetworkAllowed(resource?: NetworkResource): boolean {
  const scope = networkScope.getStore();
  return allowNetwork(
    scope?.restricted ?? backgroundRestricted,
    scope?.intent ?? 'prefetch',
    behavior,
    resource ?? scope?.resource,
  );
}
