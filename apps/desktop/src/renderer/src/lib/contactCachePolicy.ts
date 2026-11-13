import type { ContactMetric, ContactMetricRows } from '@weq/service';

export const CACHE_DAY_MS = 24 * 60 * 60 * 1000;
export function contactCacheFields(control: 'sort' | 'grouping', basis: string): ContactMetric[] {
  if (control === 'grouping')
    return basis === 'direction'
      ? ['direction']
      : basis === 'source'
        ? ['source', 'sourceGroup']
        : basis === 'school'
          ? ['schools']
          : basis === 'freezeState'
            ? ['freezeState']
            : basis === 'grade'
              ? ['grade']
              : [];
  return [
    'level',
    'likeCount',
    'addedAt',
    'commonFriends',
    'commonGroups',
    'friendCount',
    'activityScore',
    'energy',
    'joinedAt',
  ].includes(basis)
    ? [basis as ContactMetric]
    : [];
}
/** 只检查本次切换的依据；另一控件的选择不参与是否弹窗的判断。 */
export function shouldOfferContactRefresh(
  rows: ContactMetricRows,
  fields: ContactMetric[],
  entities: readonly (readonly string[])[],
  now = Date.now(),
) {
  return entities.some((aliases) =>
    fields.some((metric) => {
      const updatedAt = Math.max(0, ...aliases.map((key) => rows[key]?.[metric]?.updatedAt ?? 0));
      return updatedAt === 0 || now - updatedAt > 7 * CACHE_DAY_MS;
    }),
  );
}
