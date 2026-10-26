import type { FileSearchHit, SearchCategory } from './unified_search';
import type { ContentSearchHit } from './content_search';

/** 默认只搜账号真实资料，公共目录与生成内容由用户显式加入。 */
export const DEFAULT_SEARCH_CATEGORIES: readonly SearchCategory[] = [
  'conversation',
  'friend',
  'chatRecord',
  'file',
  'collection',
  'groupMember',
  'qzonePost',
  'qzoneAlbum',
  'otherQzonePost',
  'otherQzoneAlbum',
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
