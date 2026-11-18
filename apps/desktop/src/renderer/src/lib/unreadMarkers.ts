import { preferenceValue, useClientPreferences } from './clientPreferences';
import { AGGREGATE_BADGE_SETTINGS } from '@weq/service/client-preferences';

export function useUnreadMarkers() {
  useClientPreferences((state) => state.tick);
  return {
    requests: preferenceValue('showContactRequestBadge'),
    running: preferenceValue('showTaskRunningBadge'),
    tasks: preferenceValue('showTaskResultBadge'),
    updates: preferenceValue('showUpdateBadge'),
    important: preferenceValue('showImportantMessageMarkers'),
    aggregates: Object.fromEntries(
      AGGREGATE_BADGE_SETTINGS.map(([kind, key]) => [kind, preferenceValue(key)]),
    ),
  };
}
