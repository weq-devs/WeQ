import type { QzoneShare } from '@weqbot/protocol/web';
import { useContext, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Eye, MessageCircle, Repeat2, ThumbsUp } from 'lucide-react';
import { trpc } from '../trpc/client';
import {
  canShareQzoneFeed,
  projectPublicCommentsPage,
  projectPublicFeed,
  projectQzoneHomeFeed,
  publicGridMedia,
  qzoneHomeAlbumMedia,
  qzoneHomeBlogId,
  qzoneHomeShareId,
  type QzoneHomeAlbumMedia,
  type PublicCommentView,
  type PublicFeedView,
} from '../lib/qzonePublic';
import { qzoneLinkTarget, qzoneMediaSource } from '../lib/qzone';
import { useQQAction } from '../components/qq-actions/shared.shared';
import { QzoneActionsRow } from '../components/QzoneActionsRow';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { QzoneFeedLinks } from '../components/QzoneFeedLinks';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { QzoneTime } from '../components/QzoneTime';
import { QzoneFeedShareMenu } from '../components/QzoneShareCard';
import { useContentMultiSelect } from '../state/contentSelection.shared';
import { useMultiSelection, type MultiSelectionItemProps } from '../hooks/useMultiSelection';
import { QzoneHomeOverview } from './QzoneHomeOverview';
import { QzoneBlogCard } from './QzoneBlogs';
import { qzoneBlogSortTime, type QzoneBlog, type QzoneBlogIndex } from './QzoneBlogs.shared';
import { QzoneSharePost } from './QzoneMore';
import type { QzoneShareIndex } from './QzoneMore.shared';
import { QzoneAutoPage } from './QzonePagination';
import { QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext, type QzoneHomeDestination } from './qzoneShared.shared';
import { qzoneNickname } from '../lib/qzonePeople';

function FeedContent({ feed, share }: { feed: PublicFeedView; share?: QzoneShare }) {
  const preview = projectQzoneHomeFeed(feed);
  const { type } = preview;
  const title = share?.title || preview.title;
  const href = qzoneLinkTarget(share?.originalUrl ?? '') ?? preview.href;
  const grid = publicGridMedia(feed.media);
  const { videos } = grid;
  const shareCover = qzoneMediaSource(share?.previewUrl ?? '');
  const images = !grid.images.length && !videos.length && shareCover ? [shareCover] : grid.images;
  const cover = href && type === '分享' && !videos.length ? images[0] : undefined;
  const memo = share?.memo || feed.text;
  const text = memo === title ? '' : memo;
  return (
    <>
      {title && !href ? (
        <h3 className="weq-qzn-blog-title" data-privacy-sensitive>
          <QzoneInlineText content={title} />
        </h3>
      ) : null}
      {text ? (
        <p className="weq-qzn-content" data-privacy-sensitive>
          <QzoneInlineText content={text} />
        </p>
      ) : !title && !href && !images.length && !videos.length ? (
        <p className="weq-qzn-content weq-qzn-status">动态内容暂不可预览</p>
      ) : null}
      <QzoneMediaGrid
        images={cover ? images.slice(1) : images}
        videos={videos}
        album={qzoneHomeAlbumMedia(feed)}
      />
      {href ? (
        <QzoneFeedLinks
          links={[
            {
              href,
              text: title || `打开${type}`,
              cover,
              kind: share?.category === 18 ? 'music' : 'link',
            },
          ]}
          ownerUin={feed.author.uin}
          ownerNickname={feed.author.nick}
        />
      ) : null}
    </>
  );
}

type OpenSpace = (uin: string, nickname?: string) => void;

export type QzoneHomePostProps = {
  feed: PublicFeedView;
  tid: string;
  album?: QzoneHomeAlbumMedia;
  selfUin: string;
  configId: string;
  available: boolean;
  onSpace: OpenSpace;
  onDeleted: (tid: string) => void;
  selectionProps?: MultiSelectionItemProps;
  selected?: boolean;
};

function FeedCommentRows({
  comments,
  onSpace,
}: {
  comments: PublicCommentView[];
  onSpace: OpenSpace;
}) {
  return (
    <>
      {comments.map((comment, index) => (
        <div key={comment.id || index}>
          {[comment, ...comment.replies].map((row, replyIndex) => (
            <QzoneCommentRow
              key={row.id ? `${replyIndex === 0 ? 'comment' : 'reply'}:${row.id}` : replyIndex}
              uin={row.author.uin}
              nickname={row.author.nick}
              time={row.time}
              onSpace={onSpace}
              className={replyIndex > 0 ? 'is-reply' : undefined}
            >
              {row.text ? (
                <p data-privacy-sensitive>
                  <QzoneInlineText content={row.text} />
                </p>
              ) : null}
              {row.media.length ? <QzoneMediaGrid {...publicGridMedia(row.media)} /> : null}
            </QzoneCommentRow>
          ))}
        </div>
      ))}
    </>
  );
}

function FeedReadCounts({ feed }: { feed: PublicFeedView }) {
  return (
    <>
      {feed.likeCount !== null ? (
        <span title="赞">
          <ThumbsUp size={16} aria-hidden />
          <span className="weq-qzn-action-label">赞</span>{' '}
          <span className="weq-number">{feed.likeCount}</span>
        </span>
      ) : null}
      {feed.forwardCount !== null ? (
        <span title="转发">
          <Repeat2 size={16} aria-hidden />
          <span className="weq-qzn-action-label">转发</span>{' '}
          <span className="weq-number">{feed.forwardCount}</span>
        </span>
      ) : null}
      {feed.viewCount !== null ? (
        <span className="weq-qzn-views" title="浏览量（非去重访客数）">
          <Eye size={16} aria-hidden />
          <span className="weq-number">{feed.viewCount}</span>
        </span>
      ) : null}
    </>
  );
}

function HomeFeedCard({
  feed,
  selfUin,
  onSpace,
}: {
  feed: PublicFeedView;
  selfUin: string;
  onSpace: OpenSpace;
}) {
  const { type } = projectQzoneHomeFeed(feed);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const comments = projectPublicCommentsPage(feed.feed).comments;
  const counts = [
    [ThumbsUp, '赞', feed.likeCount],
    [MessageCircle, '评论', feed.commentCount],
    [Repeat2, '转发', feed.forwardCount],
  ] as const;
  return (
    <article className="weq-qzn-post">
      <header className="weq-qzn-post-head">
        <QzonePersonHeader
          size={34}
          url={feed.author.portrait}
          uin={feed.author.uin}
          nickname={feed.author.nick || feed.author.uin || '空间用户'}
          onSpace={onSpace}
          time={<QzoneTime value={feed.time} />}
        />
        <span className="weq-qzn-feed-kind">{type}</span>
        {canShareQzoneFeed(feed.feed) ? (
          <div className="weq-qzn-post-tools">
            <QzoneFeedShareMenu selfUin={selfUin} feed={feed.feed} feedKey={feed.key} />
          </div>
        ) : null}
      </header>
      <FeedContent feed={feed} />
      {comments.length ||
      feed.viewCount !== null ||
      counts.some(([, , count]) => count !== null) ? (
        <QzoneActionsRow>
          {counts.map(([Icon, label, count]) => {
            if (label === '评论' && comments.length) {
              return (
                <button
                  key={label}
                  type="button"
                  title="评论预览"
                  aria-expanded={commentsOpen}
                  onClick={() => setCommentsOpen((open) => !open)}
                >
                  <Icon size={16} aria-hidden />
                  <span className="weq-qzn-action-label">{label}</span>{' '}
                  <span className="weq-number">{count ?? '?'}</span>
                </button>
              );
            }
            return count === null ? null : (
              <span key={label} title={label}>
                <Icon size={16} aria-hidden />
                <span className="weq-qzn-action-label">{label}</span>{' '}
                <span className="weq-number">{count}</span>
              </span>
            );
          })}
          {feed.viewCount !== null ? (
            <span className="weq-qzn-views" title="浏览量（非去重访客数）">
              <Eye size={16} aria-hidden />
              <span className="weq-number">{feed.viewCount}</span>
            </span>
          ) : null}
        </QzoneActionsRow>
      ) : null}
      {commentsOpen ? (
        <section className="weq-qzn-interaction" aria-label="评论预览">
          <FeedCommentRows comments={comments} onSpace={onSpace} />
        </section>
      ) : null}
    </article>
  );
}

type HomeRow =
  | {
      kind: 'feed';
      time: number;
      feed: PublicFeedView;
      tid: string | null;
      album?: QzoneHomeAlbumMedia;
    }
  | { kind: 'blog'; time: number; blog: QzoneBlog; feed?: PublicFeedView }
  | { kind: 'share'; time: number; share: QzoneShare; feed?: PublicFeedView };

function homeShareKey(uin: string, id: string) {
  return `share:${uin}:${id}`;
}

function homeRows(
  pages: readonly { feeds: readonly unknown[] }[],
  blogs: readonly QzoneBlog[],
  shares: readonly QzoneShare[],
  hostUin: string,
  deletedPosts: ReadonlySet<string>,
) {
  const rows = new Map<string, HomeRow>();
  const postAlbums = new Map<string, QzoneHomeAlbumMedia>();
  const byBlogId = new Map(blogs.map((blog) => [blog.id, blog]));
  const byShareId = new Map(shares.map((share) => [share.id, share]));
  let feedFloor = Number.POSITIVE_INFINITY;
  let blogFloor = Number.POSITIVE_INFINITY;
  let shareFloor = Number.POSITIVE_INFINITY;
  for (const [pageIndex, page] of pages.entries()) {
    for (const [index, raw] of page.feeds.entries()) {
      const feed = projectPublicFeed(raw, index);
      if (!feed || feed.advertisement) continue;
      if (feed.time > 0) feedFloor = Math.min(feedFloor, feed.time);
      const { detailId: tid, title } = projectQzoneHomeFeed(feed);
      if (tid && deletedPosts.has(tid)) continue;
      const blogId = qzoneHomeBlogId(feed);
      if (blogId) {
        const key = `blog:${feed.author.uin}:${blogId}`;
        if (rows.has(key)) continue;
        const indexed = feed.author.uin === hostUin ? byBlogId.get(blogId) : undefined;
        const blog = {
          id: blogId,
          title: indexed?.title || title,
          summary: indexed?.summary ?? '',
          images: indexed?.images.length ? indexed.images : publicGridMedia(feed.media).images,
          publishedAt: indexed?.publishedAt ?? '',
          commentCount: indexed?.commentCount ?? feed.commentCount,
        };
        rows.set(key, { kind: 'blog', blog, feed, time: feed.time || qzoneBlogSortTime(blog) });
        continue;
      }
      const shareId = qzoneHomeShareId(feed);
      if (shareId) {
        const key = homeShareKey(feed.author.uin, shareId);
        if (rows.has(key)) continue;
        const indexed = feed.author.uin === hostUin ? byShareId.get(shareId) : undefined;
        const share = indexed ?? {
          id: shareId,
          category: null,
          memo: '',
          publishedAt: '',
          publishedTime: null,
          title: '',
          originalUrl: '',
          previewUrl: '',
        };
        rows.set(key, { kind: 'share', share, feed, time: feed.time || share.publishedTime || 0 });
        continue;
      }
      const key = tid
        ? `post:${tid}`
        : feed.key.startsWith('#')
          ? `${pageIndex}:${feed.key}`
          : feed.key;
      if (!rows.has(key)) {
        const album = tid ? qzoneHomeAlbumMedia(feed) : undefined;
        if (tid && album?.hostUin === hostUin) postAlbums.set(tid, album);
        rows.set(key, { kind: 'feed', feed, tid, time: feed.time, album });
      }
    }
  }
  for (const blog of blogs) {
    const time = qzoneBlogSortTime(blog);
    if (time > 0) blogFloor = Math.min(blogFloor, time);
    const key = `blog:${hostUin}:${blog.id}`;
    if (!rows.has(key)) rows.set(key, { kind: 'blog', blog, time });
  }
  for (const share of shares) {
    const time = share.publishedTime ?? 0;
    if (time > 0) shareFloor = Math.min(shareFloor, time);
    const key = homeShareKey(hostUin, share.id);
    if (!rows.has(key)) rows.set(key, { kind: 'share', share, time });
  }
  return {
    rows: [...rows].sort((a, b) => b[1].time - a[1].time),
    postAlbums,
    feedFloor,
    blogFloor,
    shareFloor,
  };
}

export function QzoneSpaceHome({
  selfUin,
  hostUin,
  onSpace,
  PostCard,
  blogIndex,
  shareIndex,
  nickname,
  onOwnerNickname,
  onOpenPane,
  deletedPosts,
  onPostAlbums,
  onDeleted,
}: {
  selfUin: string;
  hostUin: string;
  onSpace: OpenSpace;
  PostCard: ComponentType<QzoneHomePostProps>;
  blogIndex: QzoneBlogIndex;
  shareIndex: QzoneShareIndex;
  nickname: string;
  onOwnerNickname: (uin: string, nickname: string) => void;
  onOpenPane: (pane: QzoneHomeDestination) => void;
  deletedPosts: ReadonlySet<string>;
  onPostAlbums: (albums: {
    configId: string;
    byPost: ReadonlyMap<string, QzoneHomeAlbumMedia>;
  }) => void;
  onDeleted: (tid: string) => void;
}) {
  const { active } = useContext(QzonePageContext);
  const session = useQQAction(`qzone-home:${hostUin}`, 'failure-only');
  const binding = session.binding?.expectedAccountUin === selfUin ? session.binding : null;
  const available = Boolean(binding && session.available);
  const query = trpc.account.qqActions.qzoneHome.useInfiniteQuery(
    { ...session.binding!, hostUin },
    {
      enabled: available && active,
      refetchOnWindowFocus: false,
      getNextPageParam: (page, pages) =>
        page.next_cursor &&
        !pages.slice(0, -1).some((item) => item.next_cursor === page.next_cursor)
          ? page.next_cursor
          : undefined,
      retry: false,
    },
  );
  const { rows, postAlbums, feedFloor, blogFloor, shareFloor } = useMemo(
    () =>
      homeRows(query.data?.pages ?? [], blogIndex.items, shareIndex.items, hostUin, deletedPosts),
    [query.data?.pages, blogIndex.items, shareIndex.items, hostUin, deletedPosts],
  );
  const configId = binding?.expectedAccountConfigId ?? '';
  useEffect(
    () => onPostAlbums({ configId, byPost: postAlbums }),
    [configId, onPostAlbums, postAlbums],
  );
  const ownerNick = rows.find(
    ([, { feed }]) => feed?.author.uin === hostUin && qzoneNickname(hostUin, feed.author.nick),
  )?.[1].feed?.author.nick;
  useEffect(() => {
    if (ownerNick) onOwnerNickname(hostUin, ownerNick);
  }, [hostUin, ownerNick, onOwnerNickname]);
  const selectableIds = useMemo(
    () =>
      rows.flatMap(([, row]) =>
        row.kind === 'feed' && row.tid && row.feed.author.uin === hostUin ? [row.tid] : [],
      ),
    [hostUin, rows],
  );
  const selection = useContentMultiSelect({ kind: 'qzone-posts', container: hostUin });
  const multi = useMultiSelection({
    ids: selectableIds,
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    anchorRef: selection.anchorRef,
    enabled: selection.selectionMode,
    disabled: !selectableIds.length,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  const pages = query.data?.pages ?? [];
  const cursor = pages.at(-1)?.next_cursor;
  const cursorStalled = !!cursor && pages.slice(0, -1).some((page) => page.next_cursor === cursor);
  const error = query.error?.message ?? '';
  const next = () => void query.fetchNextPage({ cancelRefetch: false });
  const retry = () => (query.hasNextPage ? next() : void query.refetch());
  // 先续已读范围最浅的来源，不为合并提前扫完整历史。
  const nextPage = [
    { floor: feedFloor, next: available && query.hasNextPage && !error ? next : undefined },
    {
      floor: blogFloor,
      next: blogIndex.hasNextPage && !blogIndex.error ? blogIndex.next : undefined,
    },
    { floor: shareFloor, next: !shareIndex.error ? shareIndex.onNext : undefined },
  ]
    .filter((source) => source.next)
    .sort((a, b) => b.floor - a.floor)[0]?.next;
  const loading = query.isFetching || blogIndex.loading || shareIndex.loading;
  return (
    <div className="weq-qzn-timeline weq-qzn-home">
      {binding ? (
        <QzoneHomeOverview
          key={binding.expectedAccountConfigId}
          binding={binding}
          available={available}
          hostUin={hostUin}
          blogCount={blogIndex.total}
          onOwnerNickname={onOwnerNickname}
          onOpenPane={onOpenPane}
        />
      ) : null}
      {!rows.length ? (
        !available ? (
          <State
            loading={blogIndex.loading || shareIndex.loading}
            error=""
            empty="当前无法读取在线主页"
            progress="可查看「说说」或「相册」。"
          />
        ) : (
          <State
            loading={loading}
            error={error}
            empty={query.isSuccess && !nextPage && !loading ? '这个空间暂无可查看的动态。' : ''}
            retry={retry}
          />
        )
      ) : error ? (
        <State loading={false} error={error} empty="" retry={retry} />
      ) : null}
      <div {...multi.rootProps}>
        {rows.map(([key, row]) => {
          if (row.kind === 'share') {
            const { feed, share } = row;
            return (
              <QzoneSharePost
                key={`${shareIndex.configId}:${key}`}
                share={share}
                refresh={shareIndex.refresh}
                space={{
                  selfUin,
                  hostUin: feed?.author.uin ?? hostUin,
                  nickname: feed?.author.nick || nickname,
                  onSpace,
                }}
                timeline={{
                  time: feed?.time ?? 0,
                  portrait: feed?.author.portrait,
                  content: feed ? <FeedContent feed={feed} share={share} /> : undefined,
                  tools:
                    feed && canShareQzoneFeed(feed.feed) ? (
                      <div className="weq-qzn-post-tools">
                        <QzoneFeedShareMenu selfUin={selfUin} feed={feed.feed} feedKey={feed.key} />
                      </div>
                    ) : undefined,
                  counts: feed ? <FeedReadCounts feed={feed} /> : undefined,
                  commentCount: feed?.commentCount,
                  commentPreview: feed ? (
                    <FeedCommentRows
                      comments={projectPublicCommentsPage(feed.feed).comments}
                      onSpace={onSpace}
                    />
                  ) : undefined,
                }}
              />
            );
          }
          if (row.kind === 'blog') {
            const { blog, feed } = row;
            if (feed && !blogIndex.configId)
              return <HomeFeedCard key={key} selfUin={selfUin} feed={feed} onSpace={onSpace} />;
            return (
              <QzoneBlogCard
                key={key}
                blog={blog}
                input={feed ? { ...blogIndex.input, hostUin: feed.author.uin } : blogIndex.input}
                nickname={feed ? feed.author.nick : nickname}
                onSpace={onSpace}
                timeline={{
                  time: feed?.time ?? 0,
                  portrait: feed?.author.portrait ?? '',
                  preview:
                    feed?.text && feed.text !== blog.title ? (
                      <p className="weq-qzn-content" data-privacy-sensitive>
                        <QzoneInlineText content={feed.text} />
                      </p>
                    ) : undefined,
                  tools:
                    feed && canShareQzoneFeed(feed.feed) ? (
                      <div className="weq-qzn-post-tools">
                        <QzoneFeedShareMenu selfUin={selfUin} feed={feed.feed} feedKey={feed.key} />
                      </div>
                    ) : undefined,
                  counts: feed ? <FeedReadCounts feed={feed} /> : undefined,
                }}
              />
            );
          }
          const { feed, tid, album } = row;
          return tid && binding ? (
            <PostCard
              key={key}
              selfUin={selfUin}
              configId={binding.expectedAccountConfigId}
              available={available}
              feed={feed}
              tid={tid}
              album={album}
              onSpace={onSpace}
              onDeleted={(deletedTid) => {
                if (selection.selectedIds.has(deletedTid))
                  selection.setSelectedIds(
                    (ids) => new Set([...ids].filter((id) => id !== deletedTid)),
                  );
                onDeleted(deletedTid);
              }}
              selectionProps={feed.author.uin === hostUin ? multi.itemProps(tid) : undefined}
              selected={selection.selectedIds.has(tid)}
            />
          ) : (
            <HomeFeedCard key={key} selfUin={selfUin} feed={feed} onSpace={onSpace} />
          );
        })}
      </div>
      {blogIndex.error ? (
        <State loading={false} error={blogIndex.error} empty="" retry={blogIndex.retry} />
      ) : null}
      {shareIndex.error ? (
        <State
          loading={false}
          error={`历史分享：${shareIndex.error}`}
          empty=""
          retry={shareIndex.onRetry}
        />
      ) : null}
      {cursorStalled ? (
        <p role="alert" className="weq-qzn-status">
          主页分页未推进，请刷新核对。
        </p>
      ) : null}
      {nextPage ? (
        <QzoneAutoPage
          key={`${pages.length}:${blogIndex.pages}:${shareIndex.pageCount}`}
          loading={loading}
          onNext={nextPage}
        />
      ) : null}
    </div>
  );
}
