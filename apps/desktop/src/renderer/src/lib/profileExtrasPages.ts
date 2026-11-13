export interface ExtrasPage<T extends { id: string }, C = string | number> {
  items: T[];
  nextCursor: C | null;
  hasMore: boolean;
  paginationError: string | null;
}
export function mergeExtrasPages<T extends { id: string }>(pages: Array<{ items: T[] }>): T[] {
  return [...new Map(pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()];
}
export function extrasPageWarning<T extends { id: string }, C>(
  pages: ExtrasPage<T, C>[],
): string | null {
  const last = pages.at(-1);
  if (!last) return null;
  if (last.paginationError) return last.paginationError;
  if (!last.hasMore) return null;
  if (
    last.nextCursor === null ||
    pages.slice(0, -1).some((page) => page.nextCursor === last.nextCursor)
  )
    return '服务器返回了重复的分页游标';
  if (last.items.length && pages.length > 1) {
    const seen = new Set(mergeExtrasPages(pages.slice(0, -1)).map((item) => item.id));
    if (last.items.every((item) => seen.has(item.id))) return '服务器没有返回新的条目';
  }
  return null;
}
export function nextExtrasCursor<T extends { id: string }, C>(
  last: ExtrasPage<T, C>,
  pages: ExtrasPage<T, C>[],
): C | undefined {
  return last.hasMore && !extrasPageWarning(pages) ? (last.nextCursor ?? undefined) : undefined;
}
