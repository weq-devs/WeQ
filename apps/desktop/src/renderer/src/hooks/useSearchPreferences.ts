import { useEffect, useState } from 'react';
import {
  DEFAULT_SEARCH_CATEGORIES,
  SEARCH_CATEGORY_ORDER,
  type SearchCategory,
} from '../components/search/types';

export const SEARCH_PREFERENCES_KEY = 'weq.global-search.preferences';

export function readSearchPreferences(): {
  categories: SearchCategory[];
  appEnabled: boolean;
  numberLookupEnabled: boolean;
} {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(SEARCH_PREFERENCES_KEY) ?? 'null',
    );
    if (
      value &&
      typeof value === 'object' &&
      'categories' in value &&
      Array.isArray(value.categories)
    ) {
      const saved = value.categories;
      return {
        categories: SEARCH_CATEGORY_ORDER.filter((category) => saved.includes(category)),
        appEnabled: !('appEnabled' in value) || value.appEnabled !== false,
        numberLookupEnabled:
          !('numberLookupEnabled' in value) || value.numberLookupEnabled !== false,
      };
    }
  } catch {}
  return {
    categories: [...DEFAULT_SEARCH_CATEGORIES],
    appEnabled: true,
    numberLookupEnabled: true,
  };
}

export function useSearchPreferences() {
  const [initial] = useState(readSearchPreferences);
  const [categories, setCategories] = useState(initial.categories);
  const [appEnabled, setAppEnabled] = useState(initial.appEnabled);
  const [numberLookupEnabled, setNumberLookupEnabled] = useState(initial.numberLookupEnabled);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SEARCH_PREFERENCES_KEY,
        JSON.stringify({ categories, appEnabled, numberLookupEnabled }),
      );
    } catch {}
  }, [categories, appEnabled, numberLookupEnabled]);
  return {
    categories,
    setCategories,
    appEnabled,
    setAppEnabled,
    numberLookupEnabled,
    setNumberLookupEnabled,
  };
}
