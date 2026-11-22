import { useContext, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Eye, MessageCircle, Repeat2, ThumbsUp } from 'lucide-react';
import { trpc } from '../trpc/client';
import {
  canShareQzoneFeed,
  projectPublicCommentsPage,
  projectPublicFeed,
  projectQzoneHomeFeed,
  publicGridMedia,
  qzoneHomeBlogId,
  type PublicCommentView,
  type PublicFeedView,
} from '../lib/qzonePublic';
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
import {
  QzoneBlogCard,
  qzoneBlogSortTime,
  type QzoneBlog,
  type QzoneBlogIndex,
} from './QzoneBlogs';
import { QzoneAutoPage } from './QzonePagination';
import { QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext } from './qzoneShared.shared';
import { qzoneNickname } from '../lib/qzonePeople';

function FeedContent({ feed }: { feed: PublicFeedView }) {
  const { type, title, href } = projectQzoneHomeFeed(feed);
  const { images, videos } = publicGridMedia(feed.media);
  const cover = href && type === '分享' && !videos.length ? images[0] : undefined;
  const text = feed.text === title ? '' : feed.text;
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
      ) : !title && !href && !feed.media.length ? (
        <p className="weq-qzn-content weq-qzn-status">动态内容暂不可预览</p>
      ) : null}
      <QzoneMediaGrid images={cover ? images.slice(1) : images} videos={videos} />
      {href ? (
        <QzoneFeedLinks
          links={[{ href, text: title || `打开${type}`, cover }]}
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
  selfUin: string;
  onSpace: OpenSpace;
  onDeleted: (tid: string) => void;
  selectionProps?: MultiSelectionItemProps;
  selected?: boolean;
};

function FeedComments({
  comments,
  onSpace,
}: {
  comments: PublicCommentView[];
  onSpace: OpenSpace;
}) {
  if (!comments.length) return null;
  return (
    <section className="weq-qzn-interaction" aria-label="评论预览">
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
    </section>
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
      {commentsOpen ? <FeedComments comments={comments} onSpace={onSpace} /> : null}
    </article>
  );
}

type HomeRow =
  | { kind: 'feed'; time: number; feed: PublicFeedView; tid: string | null }
  | { kind: 'blog'; time: number; blog: QzoneBlog; feed?: PublicFeedView };

function homeRows(
  pages: readonly { feeds: readonly unknown[] }[],
  blogs: readonly QzoneBlog[],
  hostUin: string,
  deletedPosts: ReadonlySet<string>,
) {
  const rows = new Map<string, HomeRow>();
  const byBlogId = new Map(blogs.map((blog) => [blog.id, blog]));
  let feedFloor = Number.POSITIVE_INFINITY;
  let blogFloor = Number.POSITIVE_INFINITY;
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
      const key = tid
        ? `post:${tid}`
        : feed.key.startsWith('#')
          ? `${pageIndex}:${feed.key}`
          : feed.key;
      if (!rows.has(key)) rows.set(key, { kind: 'feed', feed, tid, time: feed.time });
    }
  }
  for (const blog of blogs) {
    const time = qzoneBlogSortTime(blog);
    if (time > 0) blogFloor = Math.min(blogFloor, time);
    const key = `blog:${hostUin}:${blog.id}`;
    if (!rows.has(key)) rows.set(key, { kind: 'blog', blog, time });
  }
  return { rows: [...rows].sort((a, b) => b[1].time - a[1].time), feedFloor, blogFloor };
}

export function QzoneSpaceHome({
  selfUin,
  hostUin,
  onSpace,
  PostCard,
  blogIndex,
  nickname,
  onOwnerNickname,
  deletedPosts,
  onDeleted,
}: {
  selfUin: string;
  hostUin: string;
  onSpace: OpenSpace;
  PostCard: ComponentType<QzoneHomePostProps>;
  blogIndex: QzoneBlogIndex;
  nickname: string;
  onOwnerNickname: (uin: string, nickname: string) => void;
  deletedPosts: ReadonlySet<string>;
  onDeleted: (tid: string) => void;
}) {
  const { active } = useContext(QzonePageContext);
  const session = useQQAction(`qzone-home:${hostUin}`, 'failure-only');
  const binding =
    session.available && session.binding?.expectedAccountUin === selfUin ? session.binding : null;
  const available = Boolean(binding);
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
  const { rows, feedFloor, blogFloor } = useMemo(
    () => homeRows(query.data?.pages ?? [], blogIndex.items, hostUin, deletedPosts),
    [query.data?.pages, blogIndex.items, hostUin, deletedPosts],
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
  const moreFeeds = available && query.hasNextPage && !error;
  const moreBlogs = blogIndex.hasNextPage && !blogIndex.error;
  // 哪个来源的已读范围更浅，就先续哪边；不为合并一次把两边的历史都扫完。
  const nextBlogPage = moreBlogs && (!moreFeeds || blogFloor > feedFloor);
  return (
    <div className="weq-qzn-timeline weq-qzn-home">
      {binding ? (
        <QzoneHomeOverview
          key={binding.expectedAccountConfigId}
          binding={binding}
          hostUin={hostUin}
          blogCount={blogIndex.total}
          onOwnerNickname={onOwnerNickname}
        />
      ) : null}
      {!rows.length ? (
        !available ? (
          <State
            loading={blogIndex.loading}
            error=""
            empty="当前无法读取在线主页"
            progress="可查看「说说」或「相册」。"
          />
        ) : (
          <State
            loading={query.isFetching || blogIndex.loading}
            error={error}
            empty={
              query.isSuccess && !moreFeeds && !blogIndex.loading
                ? '这个空间暂无可查看的动态。'
                : ''
            }
            retry={retry}
          />
        )
      ) : error ? (
        <State loading={false} error={error} empty="" retry={retry} />
      ) : null}
      <div {...multi.rootProps}>
        {rows.map(([key, row]) => {
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
          const { feed, tid } = row;
          return tid ? (
            <PostCard
              key={key}
              selfUin={selfUin}
              feed={feed}
              tid={tid}
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
      {cursorStalled ? (
        <p role="alert" className="weq-qzn-status">
          主页分页未推进，请刷新核对。
        </p>
      ) : null}
      {moreFeeds || moreBlogs ? (
        <QzoneAutoPage
          key={`${pages.length}:${blogIndex.pages}`}
          loading={query.isFetching || blogIndex.loading}
          onNext={nextBlogPage ? blogIndex.next : next}
        />
      ) : null}
    </div>
  );
}
