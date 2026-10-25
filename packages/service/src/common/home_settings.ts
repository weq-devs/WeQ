export interface HomeSettings {
  showTags: boolean;
  showGreeting: boolean;
  showHitokoto: boolean;
  blockedWords: string[];
}

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  showTags: true,
  showGreeting: true,
  showHitokoto: true,
  blockedWords: [],
};

/** 屏蔽词仅作字面匹配，去空白并按不区分大小写去重。 */
export function normalizeHomeSettings(value: unknown): HomeSettings {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const blockedWords = (Array.isArray(input.blockedWords) ? input.blockedWords : [])
    .filter((word): word is string => typeof word === 'string')
    .map((word) => word.trim())
    .filter((word) => {
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    showTags: typeof input.showTags === 'boolean' ? input.showTags : true,
    showGreeting: typeof input.showGreeting === 'boolean' ? input.showGreeting : true,
    showHitokoto: typeof input.showHitokoto === 'boolean' ? input.showHitokoto : true,
    blockedWords,
  };
}
