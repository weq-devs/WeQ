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

export type ConversationScope = 'all' | 'real' | 'virtual' | 'guild';

/** 可见范围默认全选，克隆和频道来源随会话显示范围并入对象分类。 */
export const DEFAULT_SEARCH_CATEGORIES: readonly SearchCategory[] = [
  'contact',
  'group',
  'chatRecord',
  'file',
  'groupAlbum',
  'collection',
  'qzone',
  'mailMessage',
  'assistantMessage',
];

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

/** 完整相等 > 连续命中（越短越好）> 有序断开命中（窗口越紧越好）。 */
export function searchNameRank(keyword: string, ...names: string[]): number {
  const needle = normalizedSearchText(keyword);
  if (!needle) return 0;
  const characters = [...needle].filter((char) => char !== ' ');
  let rank = 0;
  for (const name of names) {
    const text = normalizedSearchText(name);
    if (text === needle) return 4;
    const length = [...text].length;
    const at = text.indexOf(needle);
    if (at >= 0) {
      const compactness = 1 / (length + 1);
      const lengthStep = compactness - 1 / (length + 2);
      // 位置仅作同长度的细分，其加分始终小于相邻长度的差值。
      rank = Math.max(
        rank,
        3 + compactness + (lengthStep * 0.25) / ([...text.slice(0, at)].length + 1),
      );
      continue;
    }
    if (rank >= 3 || length < characters.length) continue;
    // 倒序更新各前缀的最近起点，重复字符不能复用同一位置；保留最紧完整窗口。
    const starts = new Array<number>(characters.length).fill(-1);
    let span = Number.POSITIVE_INFINITY;
    let position = 0;
    for (const char of text) {
      for (let index = characters.length - 1; index >= 0; index--) {
        if (char !== characters[index]) continue;
        if (index === 0) starts[index] = position;
        else if (starts[index - 1]! >= 0) starts[index] = starts[index - 1]!;
        else continue;
        if (index === characters.length - 1 && starts[index]! >= 0)
          span = Math.min(span, position - starts[index]! + 1);
      }
      position++;
    }
    if (Number.isFinite(span)) {
      const compactness = 1 / (span + 1);
      const spanStep = compactness - 1 / (span + 2);
      rank = Math.max(rank, 2 + compactness + (spanStep * 0.25) / (length + 1));
    }
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
