import type { QzoneEmotion } from '../views/qzone_types';

interface PostDetail {
  content: string;
  contentHasMore: boolean | null;
  repost: QzoneEmotion['repost'] | null;
  repostHasMore: boolean | null;
  contentSource?: 'native';
}

export { qzoneImageCompletionScope } from '@weq/service/qzone-media';

/** 补全返回整段正文；仅显式更多才续读，未知状态保留但不循环请求。 */
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
      contentTruncated: detail.contentHasMore ?? post.contentTruncated,
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
        contentTruncated: detail.repostHasMore ?? post.repost.contentTruncated,
      };
    }
    onProgress(post);
    const more = detail.contentHasMore === true || (sameRepost && detail.repostHasMore === true);
    if (!more) {
      const uncertain =
        (detail.contentHasMore === null && post.contentTruncated === true) ||
        (sameRepost && detail.repostHasMore === null && post.repost?.contentTruncated === true);
      return { post, issue: uncertain ? '正文完整性尚未确认' : null };
    }
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
