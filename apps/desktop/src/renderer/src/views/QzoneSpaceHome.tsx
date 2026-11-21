import { useContext, useState } from 'react';
import { Eye, FileText, MessageCircle, Repeat2, ThumbsUp, Trash2 } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import {
  projectPublicCommentsPage,
  projectPublicFeed,
  projectQzoneHomeFeed,
  publicGridMedia,
  type PublicCommentView,
  type PublicFeedView,
} from '../lib/qzonePublic';
import { useQQAction } from '../components/qq-actions/shared.shared';
import { EditorDialog } from '../components/EditorDialog';
import { CopyButton } from '../components/CopyButton';
import { NumericText } from '../components/NumericText';
import { QzoneActionsRow } from '../components/QzoneActionsRow';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { QzoneFeedLinks } from '../components/QzoneFeedLinks';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { QqArk } from '../components/ark/QqArk';
import { ActionFeedback } from '../components/qq-actions/shared';
import { QzoneHomeOverview } from './QzoneHomeOverview';
import { QzoneAutoPage } from './QzonePagination';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext, timeText } from './qzoneShared.shared';

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
              key={row.id ? `\${replyIndex === 0 ? 'comment' : 'reply'}:\${row.id}` : replyIndex}
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

function HomeFeedCard({
  feed,
  onSpace,
  openDetail,
}: {
  feed: PublicFeedView;
  onSpace: OpenSpace;
  openDetail: (hostUin: string, tid: string) => void;
}) {
  const { type, detailId } = projectQzoneHomeFeed(feed);
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
          time={
            feed.time ? (
              <time>
                <NumericText>{timeText(feed.time)}</NumericText>
              </time>
            ) : null
          }
        />
        <span className="weq-qzn-feed-kind">{type}</span>
      </header>
      <FeedContent feed={feed} />
      {detailId ||
      comments.length ||
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
          {detailId ? (
            <button type="button" onClick={() => openDetail(feed.author.uin, detailId)}>
              <FileText size={16} aria-hidden />
              查看详情
            </button>
          ) : null}
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

function OrdinaryDetail({
  hostUin,
  tid,
  selfUin,
  onClose,
  onSpace,
  refresh,
}: {
  hostUin: string;
  tid: string;
  selfUin: string;
  onClose: () => void;
  onSpace: OpenSpace;
  refresh: () => Promise<unknown>;
}) {
  const action = useQQAction(`qzone-ordinary:${hostUin}:${tid}`, 'failure-only');
  const input = { ...action.binding!, hostUin, tid };
  const detail = trpc.account.qqActions.qzoneOrdinaryDetail.useQuery(input, {
    enabled: action.available,
    retry: false,
  });
  const share = trpc.account.qqActions.qzoneOrdinaryShare.useMutation();
  const feed = projectPublicFeed(detail.data?.feed);
  return (
    <EditorDialog title="空间动态" onClose={onClose} busy={action.pending}>
      {detail.isFetching ? <LoadingStatus /> : null}
      {detail.error ? <p role="alert">{detail.error.message}</p> : null}
      {feed ? <FeedContent feed={feed} /> : null}
      {feed ? (
        <FeedComments comments={projectPublicCommentsPage(feed.feed).comments} onSpace={onSpace} />
      ) : null}
      {detail.data || share.data || share.error ? (
        <section className="weq-qzn-share-result" aria-label="分享卡片">
          {share.data ? <QqArk arkData={share.data.ark} /> : null}
          {share.data?.notice ? <p>{share.data.notice}</p> : null}
          {share.error ? <p role="alert">{share.error.message}</p> : null}
          <div className="weq-qq-action-bar">
            {detail.data && !share.data ? (
              <button
                type="button"
                className="weq-set-btn"
                disabled={share.isLoading || !action.available}
                onClick={() => share.mutate(input)}
              >
                {share.isLoading ? '正在生成…' : share.error ? '重试生成' : '生成分享卡片'}
              </button>
            ) : null}
            {share.data ? (
              <CopyButton text={share.data.ark} className="weq-set-btn weq-set-btn-primary">
                {share.data.requires_confirmation ? '确认并复制卡片' : '复制卡片'}
              </CopyButton>
            ) : null}
          </div>
        </section>
      ) : null}
      {detail.data && hostUin === selfUin ? (
        <footer className="weq-qzn-post-detail-management">
          <button
            type="button"
            className="weq-set-btn"
            data-danger="outline"
            disabled={action.disabled}
            onClick={() => {
              let confirmed = false;
              void action
                .perform(
                  async (binding) => {
                    const result = await client.account.qqActions.removeQzonePost.mutate({
                      ...binding,
                      hostUin,
                      tid,
                    });
                    confirmed = result.state === 'confirmed';
                    return result;
                  },
                  refresh,
                  '删除这条 QQ 空间说说？',
                  {
                    danger: 'outline',
                    requireReadback: true,
                    readback: async () => confirmed,
                    readbackSuccessText: '说说已删除',
                  },
                )
                .then((done) => {
                  if (done) onClose();
                });
            }}
          >
            <Trash2 size={15} aria-hidden />
            删除说说
          </button>
        </footer>
      ) : null}
      <ActionFeedback action={action} />
    </EditorDialog>
  );
}

export function QzoneSpaceHome({
  selfUin,
  hostUin,
  onSpace,
}: {
  selfUin: string;
  hostUin: string;
  onSpace: OpenSpace;
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
  const rows = new Map<string, PublicFeedView>();
  const pages = query.data?.pages ?? [];
  for (const [pageIndex, page] of pages.entries()) {
    for (const [index, raw] of page.feeds.entries()) {
      const feed = projectPublicFeed(raw, index);
      if (!feed || feed.advertisement) continue;
      const key = feed.key.startsWith('#') ? `${pageIndex}:${feed.key}` : feed.key;
      if (!rows.has(key)) rows.set(key, feed);
    }
  }
  const cursor = pages.at(-1)?.next_cursor;
  const cursorStalled = !!cursor && pages.slice(0, -1).some((page) => page.next_cursor === cursor);
  const [selected, setSelected] = useState<{ hostUin: string; tid: string } | null>(null);
  const error = query.error?.message ?? '';
  const next = () => void query.fetchNextPage({ cancelRefetch: false });
  const retry = () => (query.hasNextPage ? next() : void query.refetch());
  return (
    <div className="weq-qzn-timeline">
      {binding ? (
        <QzoneHomeOverview
          key={binding.expectedAccountConfigId}
          binding={binding}
          hostUin={hostUin}
        />
      ) : null}
      {!rows.size ? (
        !available ? (
          <State
            loading={false}
            error=""
            empty="当前无法读取在线主页"
            progress="可查看「说说」或「相册」。"
          />
        ) : (
          <State
            loading={query.isFetching}
            error={error}
            empty={query.isSuccess && !query.hasNextPage ? '这个空间暂无可查看的动态。' : ''}
            retry={retry}
          />
        )
      ) : error ? (
        <State loading={false} error={error} empty="" retry={retry} />
      ) : null}
      {[...rows].map(([key, feed]) => (
        <HomeFeedCard
          key={key}
          feed={feed}
          onSpace={onSpace}
          openDetail={(hostUin, tid) => setSelected({ hostUin, tid })}
        />
      ))}
      {cursorStalled ? (
        <p role="alert" className="weq-qzn-status">
          主页分页未推进，请刷新核对。
        </p>
      ) : null}
      {available && query.hasNextPage && !query.error ? (
        <QzoneAutoPage key={pages.length} loading={query.isFetching} onNext={next} />
      ) : null}
      {selected && available ? (
        <OrdinaryDetail
          {...selected}
          selfUin={selfUin}
          onClose={() => setSelected(null)}
          onSpace={onSpace}
          refresh={() => query.refetch()}
        />
      ) : null}
    </div>
  );
}
