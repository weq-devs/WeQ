import { preferenceValue, useClientPreferences } from './clientPreferences';
import { AGGREGATE_BADGE_SETTINGS } from '@weq/service/client-preferences';
import { useShallow } from 'zustand/react/shallow';

export function useUnreadMarkers() {
  useClientPreferences((state) => state.tick);
  const aggregates = useClientPreferences(
    useShallow(() =>
      Object.fromEntries(
        AGGREGATE_BADGE_SETTINGS.map(([kind, key]) => [kind, preferenceValue(key)]),
      ),
    ),
  );
  return {
    requests: preferenceValue('showContactRequestBadge'),
    running: preferenceValue('showTaskRunningBadge'),
    tasks: preferenceValue('showTaskResultBadge'),
    updates: preferenceValue('showUpdateBadge'),
    important: preferenceValue('showImportantMessageMarkers'),
    aggregates,
  };
}
