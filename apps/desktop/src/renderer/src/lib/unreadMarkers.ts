import { preferenceValue, useClientPreferences } from './clientPreferences';
import { AGGREGATE_BADGE_SETTINGS } from '@weq/service/client-preferences';
import { useShallow } from 'zustand/react/shallow';
import { useUpdateStore } from '../state/update';

export function useEnhancementUpdateBadge() {
  const enabled = useClientPreferences(() => preferenceValue('showUpdateBadge'));
  const packsAvailable = useUpdateStore((state) => state.packsAvailable);
  return enabled && packsAvailable;
}

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
    important: preferenceValue('showImportantMessageMarkers'),
    aggregates,
  };
}
