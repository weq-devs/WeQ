import type { GroupAlbumFeedPage, GroupAlbumFeedComment } from '@weq/service';

function mergeComments(
  previous: GroupAlbumFeedComment[],
  next: GroupAlbumFeedComment[],
): GroupAlbumFeedComment[] {
  const rows = new Map(previous.map((row) => [row.id, row]));
  for (const row of next) {
    const before = rows.get(row.id);
    rows.set(
      row.id,
      before ? { ...row, replies: mergeComments(before.replies, row.replies) } : row,
    );
  }
  return [...rows.values()];
}

/** 评论翻页保留服务器顺序与已展开回复，不拼接不同群／相册／批次。 */
export function mergeGroupAlbumFeedPages(
  previous: GroupAlbumFeedPage | null,
  next: GroupAlbumFeedPage,
): GroupAlbumFeedPage {
  if (!previous) return next;
  if (
    previous.groupCode !== next.groupCode ||
    previous.albumId !== next.albumId ||
    previous.batchId !== next.batchId
  )
    throw new Error('群相册动态目标已变化');
  return { ...next, comments: mergeComments(previous.comments, next.comments) };
}
