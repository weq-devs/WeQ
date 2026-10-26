import type { FileSearchHit, SearchCategory } from './unified_search';
import type {
  ContentSearchCategory,
  ContentSearchCoverage,
  ContentSearchHit,
} from './content_search';

export const QZONE_SEARCH_CATEGORIES = [
  'qzonePost',
  'qzoneAlbum',
  'otherQzonePost',
  'otherQzoneAlbum',
] as const satisfies readonly ContentSearchCategory[];

export function isQzoneSearchCategory(category: string): boolean {
  return QZONE_SEARCH_CATEGORIES.some((item) => item === category);
}

/** 默认只搜账号真实资料，公共目录与生成内容由用户显式加入。 */
export const DEFAULT_SEARCH_CATEGORIES: readonly SearchCategory[] = [
  'contact',
  'group',
  'chatRecord',
  'file',
  'collection',
  'qzone',
  'groupAlbum',
  'mailMessage',
  'guildMessage',
];

/** 名称完全匹配、前缀、包含、仅正文匹配依次递减；同档再按来源时间排序。 */
export function searchNameRank(keyword: string, ...names: string[]): number {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return 0;
  let rank = 0;
  for (const name of names) {
    const text = name.trim().toLocaleLowerCase();
    rank = Math.max(
      rank,
      text === needle ? 3 : text.startsWith(needle) ? 2 : text.includes(needle) ? 1 : 0,
    );
  }
  return rank;
}

export function rankContentSearchHits(
  keyword: string,
  hits: readonly ContentSearchHit[],
): ContentSearchHit[] {
  return [...hits].sort(
    (a, b) =>
      searchNameRank(keyword, b.title) - searchNameRank(keyword, a.title) ||
      b.time - a.time ||
      b.observedAt - a.observedAt ||
      a.id.localeCompare(b.id),
  );
}

/** 四个空间来源互不重叠，合并覆盖时保留任一来源的回收及保存失败提示。 */
export function qzoneSearchCoverage(
  coverage: Partial<Record<ContentSearchCategory, ContentSearchCoverage>>,
): ContentSearchCoverage | undefined {
  const sources = QZONE_SEARCH_CATEGORIES.flatMap((category) =>
    coverage[category] ? [coverage[category]] : [],
  );
  if (!sources.length) return undefined;
  const updated = sources.flatMap((source) =>
    source.updatedAt === null ? [] : [source.updatedAt],
  );
  return {
    scope: 'observed-cache',
    records: sources.reduce((total, source) => total + source.records, 0),
    limited: sources.some((source) => source.limited),
    updatedAt: updated.length ? Math.max(...updated) : null,
    available: sources.some((source) => source.available !== false),
    ...(sources.some((source) => source.persistenceFailed) ? { persistenceFailed: true } : {}),
  };
}

/** 消息附件与目录文件统一排名，保留各自身份，不按同名合并。 */
export function rankFileSearchHits<T extends FileSearchHit | ContentSearchHit>(
  keyword: string,
  hits: readonly T[],
): T[] {
  const name = (hit: T) => (hit.category === 'file' ? hit.fileName : hit.title);
  const time = (hit: T) => (hit.category === 'file' ? Number(hit.sendTime) : hit.time);
  const observed = (hit: T) => (hit.category === 'file' ? 0 : hit.observedAt);
  const key = (hit: T) => (hit.category === 'file' ? `${hit.source}:${hit.msgId}` : hit.id);
  return [...hits].sort(
    (a, b) =>
      searchNameRank(keyword, name(b)) - searchNameRank(keyword, name(a)) ||
      time(b) - time(a) ||
      observed(b) - observed(a) ||
      key(a).localeCompare(key(b)),
  );
}
