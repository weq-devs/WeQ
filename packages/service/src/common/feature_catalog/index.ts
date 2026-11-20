import { searchNameRank } from '../../account/search_policy';
import { CONTEXT_FEATURES, DRESS_FEATURES, EXPORT_FEATURES, WORKSPACE_FEATURES } from './entries';
import type { FeatureDefinition, FeatureDomain, FeatureKind } from './model';
import { NAVIGATION_FEATURES } from './navigation';
import { SETTING_FEATURES, SETTINGS_PAGE_FEATURES } from './settings';

export { DRESS_FEATURES, EXPORT_FEATURES, WORKSPACE_FEATURES } from './entries';
export {
  FEATURE_DOMAINS,
  type FeatureDefinition,
  type FeatureContext,
  type FeatureOperation,
  type FeatureDomain,
  type FeatureKind,
} from './model';
export { NAVIGATION_FEATURES } from './navigation';
export { SETTING_FEATURES, SETTINGS_PAGE_FEATURES, settingFeatureId } from './settings';

export const FEATURE_CATALOG_VERSION = 1;
const catalog: readonly FeatureDefinition[] = [
  ...Object.values(NAVIGATION_FEATURES),
  ...Object.values(WORKSPACE_FEATURES),
  ...EXPORT_FEATURES,
  ...DRESS_FEATURES,
  ...CONTEXT_FEATURES,
  ...SETTINGS_PAGE_FEATURES,
  ...SETTING_FEATURES,
];
const byId = new Map(catalog.map((entry) => [entry.id, entry]));

export function findFeature(id: string): FeatureDefinition | undefined {
  return byId.get(id);
}

export function listFeatures(
  options: { domain?: FeatureDomain; kind?: FeatureKind; query?: string } = {},
) {
  const { domain, kind } = options;
  const query = options.query?.trim();
  const candidates = catalog.filter(
    (entry) => (!domain || entry.domain === domain) && (!kind || entry.kind === kind),
  );
  if (!query) return candidates;
  return candidates
    .map((entry) => ({
      entry,
      rank: searchNameRank(query, entry.label, ...entry.aliases, entry.id),
    }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map(({ entry }) => entry);
}
