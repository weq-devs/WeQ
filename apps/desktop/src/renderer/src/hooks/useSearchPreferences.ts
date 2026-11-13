import { changePreference, preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import { useMemo, useState } from 'react';
import {
  normalizeSearchPreferences,
  type CurrentSearchPreferences,
  type SearchSource,
} from '@weq/service/search-policy';
import type { SearchCategory } from '../components/search/types';

export const SEARCH_PREFERENCES_KEY = 'weq.global-search.preferences';

export function readSearchPreferences(): CurrentSearchPreferences {
  try {
    return normalizeSearchPreferences(
      JSON.parse(window.localStorage.getItem(SEARCH_PREFERENCES_KEY) ?? 'null'),
    );
  } catch {}
  return normalizeSearchPreferences(null);
}

export function useSearchPreferences() {
  useClientPreferences((state) => state.tick);
  const [initial] = useState(readSearchPreferences);
  const saved = preferenceValue('search', initial);
  const { categories, sources, appEnabled, numberLookupEnabled } = useMemo(
    () => normalizeSearchPreferences(saved),
    [saved],
  );
  const update = (patch: Partial<CurrentSearchPreferences>) =>
    void changePreference('search', {
      ...normalizeSearchPreferences(preferenceValue('search', initial)),
      ...patch,
    });
  return {
    sources,
    setSources: (value: SearchSource[]) =>
      update({ sources: value, appEnabled: value.includes('app') }),
    categories,
    setCategories: (value: SearchCategory[]) => update({ categories: value }),
    appEnabled,
    setAppEnabled: (value: boolean) => {
      const currentSources = normalizeSearchPreferences(preferenceValue('search', initial)).sources;
      update({
        appEnabled: value,
        sources: value
          ? [...new Set([...currentSources, 'app' as const])]
          : currentSources.filter((source) => source !== 'app'),
      });
    },
    numberLookupEnabled,
    setNumberLookupEnabled: (value: boolean) => update({ numberLookupEnabled: value }),
  };
}
