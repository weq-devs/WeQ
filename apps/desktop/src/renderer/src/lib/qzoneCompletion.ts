import type { QzoneEmotion } from '../views/qzone_types';

interface PostDetail {
  content: string;
  contentHasMore: boolean | null;
  repost: QzoneEmotion['repost'] | null;
  repostHasMore: boolean | null;
}

/** R02 returns a whole body, not appendable chunks or a verified page cursor. */
export async function completeQzonePostText(
  source: QzoneEmotion,
  read: () => Promise<PostDetail>,
  onProgress: (post: QzoneEmotion) => void,
  isActive: () => boolean,
): Promise<{ post: QzoneEmotion; issue: string | null }> {
  let post = { ...source };
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!isActive()) return { post, issue: null };
    let detail: PostDetail;
    try {
      detail = await read();
    } catch {
      return { post, issue: '全文补全失败' };
    }
    if (!isActive()) return { post, issue: null };
    // Retain a longer observed excerpt if another truncated/unknown response regresses.
    post = {
      ...post,
      content:
        detail.content.length >= post.content.length || detail.contentHasMore === false
          ? detail.content
          : post.content,
      contentTruncated: detail.contentHasMore === true,
    };
    const sameRepost = Boolean(
      post.repost &&
        detail.repost &&
        post.repost.tid === detail.repost.tid &&
        post.repost.uin === detail.repost.uin,
    );
    if (sameRepost && post.repost && detail.repost) {
      post.repost = {
        ...post.repost,
        content:
          detail.repost.content.length >= post.repost.content.length ||
          detail.repostHasMore === false
            ? detail.repost.content
            : post.repost.content,
        contentTruncated: detail.repostHasMore === true,
      };
    }
    onProgress(post);
    const more = detail.contentHasMore === true || (sameRepost && detail.repostHasMore === true);
    if (!more) return { post, issue: null };
    const signature = JSON.stringify([
      detail.content,
      detail.contentHasMore,
      detail.repost?.tid,
      detail.repost?.uin,
      detail.repost?.content,
      detail.repostHasMore,
    ]);
    if (seen.has(signature)) return { post, issue: '正文仍被截断，接口未返回更多内容' };
    seen.add(signature);
  }
  return { post, issue: '正文仍被截断，已达到本轮补全上限' };
}
