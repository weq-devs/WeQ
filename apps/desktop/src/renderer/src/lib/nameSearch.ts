import { createPinyinMatcher } from '@weq/codec/pinyin-search';

/** 原文和号码优先，同一匹配等级沿用输入列表的顺序。 */
export function filterByName<T>(
  items: T[],
  query: string,
  names: (item: T) => readonly (string | null | undefined)[],
  matchesLiteral?: (item: T, needle: string) => boolean,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  const pinyin = createPinyinMatcher(needle);
  const hits = items.flatMap((item) => {
    const fields = names(item);
    const literal =
      fields.some((name) => name?.toLocaleLowerCase().includes(needle)) ||
      matchesLiteral?.(item, needle);
    const rank = literal ? 3 : (pinyin?.rank(...fields) ?? 0);
    return rank ? [{ item, rank }] : [];
  });
  return hits.sort((a, b) => b.rank - a.rank).map(({ item }) => item);
}
