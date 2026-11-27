import { formatUnixTime } from '@weq/time';
import type { QzoneShare, QzoneShareCategory } from '@weqbot/protocol/web';
import { RefreshCw } from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { useFeedCardState } from './qzoneCardState';
import { FormSelect } from '../components/FormSelect';
import { QzoneActionsRow, QzoneCommentToggle } from '../components/QzoneActionsRow';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { QzoneFeedLinks } from '../components/QzoneFeedLinks';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { QzoneTime } from '../components/QzoneTime';
import { qzoneLinkTarget, qzoneMediaSource } from '../lib/qzone';
import { client } from '../trpc/client';
import {
  useMorePages,
  useQzoneShareIndex,
  type QzoneShareIndex,
  type Space,
} from './QzoneMore.shared';
import { QzoneAutoPage } from './QzonePagination';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext, type QzoneMorePane } from './qzoneShared.shared';
import { QzoneVideoGrid } from './QzoneVideoGrid';
import { hasNewQzoneItems, useQzoneRefresh } from './qzoneRefresh';

const shareCategories = {
  0: '全部',
  1: '日志',
  2: '相册',
  3: '照片',
  4: '网页',
  5: '视频',
  10: '商品',
  13: '新闻',
  17: '微博',
  18: '音乐',
} satisfies Record<QzoneShareCategory, string>;

type PagedState = Pick<
  ReturnType<typeof useMorePages>,
  'error' | 'loading' | 'initialLoading' | 'paging' | 'onNext' | 'onRetry' | 'pageCount'
>;

function useMoreRefresh(
  state: Pick<ReturnType<typeof useMorePages>, 'items' | 'reload' | 'configId'>,
  category = 0,
) {
  useQzoneRefresh(
    async () => hasNewQzoneItems(state.items, await state.reload(), (item) => item.id),
    Boolean(state.configId),
    `${state.configId}:${category}`,
  );
}

function PageEnd({ state, empty }: { state: PagedState; empty: string }) {
  return state.error || empty || state.initialLoading ? (
    <State loading={state.initialLoading} error={state.error} retry={state.onRetry} empty={empty} />
  ) : state.onNext ? (
    <QzoneAutoPage
      key={state.pageCount}
      loading={state.loading}
      showLoading={state.paging}
      onNext={state.onNext}
    />
  ) : null;
}

function Shares({ space, shareIndex }: { space: Space; shareIndex: QzoneShareIndex }) {
  const [category, setCategory] = useState<QzoneShareCategory>(0);
  const { active } = useContext(QzonePageContext);
  const filtered = useQzoneShareIndex(space, category, { active: active && category !== 0 });
  const state = category === 0 ? shareIndex : filtered;
  useMoreRefresh(state, category);
  return (
    <>
      <div className="weq-qzn-more-toolbar">
        <FormSelect
          aria-label="分享分类"
          value={category}
          onChange={(event) => setCategory(Number(event.target.value) as QzoneShareCategory)}
        >
          {Object.entries(shareCategories).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </FormSelect>
      </div>
      {state.items.map((share) => (
        <QzoneSharePost
          key={`${state.configId}:${share.id}`}
          space={space}
          share={share}
          refresh={shareIndex.refresh}
        />
      ))}
      <PageEnd
        key={category}
        state={state}
        empty={state.first && !state.items.length ? '这个分类暂无分享' : ''}
      />
    </>
  );
}

export function QzoneSharePost({
  space,
  share,
  refresh,
  timeline,
}: {
  space: Space;
  share: QzoneShare;
  refresh: number;
  timeline?: {
    time: number;
    portrait?: string;
    content?: ReactNode;
    tools?: ReactNode;
    counts?: ReactNode;
    commentCount?: number | null;
    commentPreview?: ReactNode;
  };
}) {
  const [commentsOpen, setCommentsOpen] = useFeedCardState('share-comments');
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const time = timeline?.time || formatUnixTime(share.publishedTime, 'minute') || share.publishedAt;
  return (
    <article className="weq-qzn-post">
      <header className="weq-qzn-post-head">
        <QzonePersonHeader
          url={timeline?.portrait}
          uin={space.hostUin}
          nickname={space.nickname || space.hostUin}
          onSpace={space.onSpace}
          size={34}
          time={<QzoneTime value={time} />}
        />
        {timeline ? <span className="weq-qzn-feed-kind">分享</span> : null}
        {timeline?.tools}
      </header>
      {timeline?.content ?? <ShareContent share={share} space={space} />}
      <QzoneActionsRow>
        <QzoneCommentToggle
          expanded={commentsOpen}
          count={commentCount ?? timeline?.commentCount ?? null}
          onToggle={() => setCommentsOpen((open) => !open)}
        />
        {timeline?.counts}
      </QzoneActionsRow>
      {commentsOpen ? (
        <ShareCommentList
          space={space}
          shareId={share.id}
          refresh={refresh}
          onCount={setCommentCount}
          preview={timeline?.commentPreview}
        />
      ) : null}
    </article>
  );
}

function ShareContent({ space, share }: { space: Space; share: QzoneShare }) {
  const href = qzoneLinkTarget(share.originalUrl);
  const cover = qzoneMediaSource(share.previewUrl);
  const title = share.title || '分享';
  return (
    <>
      {share.memo ? (
        <p className="weq-qzn-content" data-privacy-sensitive>
          <QzoneInlineText content={share.memo} />
        </p>
      ) : null}
      <div className="weq-qzn-share-preview">
        {href ? (
          <QzoneFeedLinks
            links={[
              {
                href,
                text: share.title || '打开原链接',
                cover: cover ?? undefined,
                kind: share.category === 18 ? 'music' : 'link',
              },
            ]}
            ownerUin={space.hostUin}
            ownerNickname={space.nickname}
          />
        ) : (
          <>
            <h3 className="weq-qzn-more-title" data-privacy-sensitive>
              {title}
            </h3>
            {cover ? <QzoneMediaGrid images={[cover]} /> : null}
          </>
        )}
      </div>
    </>
  );
}

function ShareCommentList({
  space,
  shareId,
  refresh,
  onCount,
  preview,
}: {
  space: Space;
  shareId: string;
  refresh: number;
  onCount: (count: number) => void;
  preview?: ReactNode;
}) {
  const { first, items, loading, initialLoading, paging, error, onNext, onRetry, pageCount } =
    useMorePages(
      space,
      `share-comments:${shareId}`,
      1,
      (input, page) => client.account.qzone.shareComments.query({ ...input, shareId, page }),
      { refresh },
    );
  const count = first?.total;
  useEffect(() => {
    if (count !== undefined) onCount(count);
  }, [count, onCount]);
  return (
    <section className="weq-qzn-interaction" aria-label="分享评论">
      {!first ? preview : null}
      {count === 0 ? <p className="weq-qzn-status">暂无评论</p> : null}
      {items.map((row) => (
        <div key={row.id}>
          {[row, ...row.replies].map((comment, index) => (
            <QzoneCommentRow
              key={comment.id}
              uin={comment.uin}
              nickname={comment.nickname}
              time={comment.publishedAt}
              onSpace={space.onSpace}
              className={index > 0 ? 'is-reply' : undefined}
            >
              <p data-privacy-sensitive>
                <QzoneInlineText content={comment.text} />
              </p>
            </QzoneCommentRow>
          ))}
        </div>
      ))}
      {initialLoading ? <LoadingStatus text="正在加载评论…" /> : null}
      {error ? (
        <p className="weq-qzn-error" role="status">
          {error}{' '}
          <button type="button" className="weq-retry-button" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden />
            重试
          </button>
        </p>
      ) : null}
      {onNext && !error ? (
        <QzoneAutoPage key={pageCount} loading={loading} showLoading={paging} onNext={onNext} />
      ) : null}
    </section>
  );
}

function Visitors({ space }: { space: Space }) {
  const state = useMorePages(space, 'visitors', 1, (input, page) =>
    client.account.qzone.visitors.query({ ...input, page }),
  );
  const first = state.first;
  useMoreRefresh(state);
  const empty =
    first?.status === 'forbidden'
      ? '无权查看这个空间的访客'
      : first?.status === 'unavailable'
        ? 'QQ 空间未说明最近访客为空，还是名单不可见'
        : first && !state.items.length
          ? '最近没有访客'
          : '';
  return (
    <>
      {state.items.map((person) => (
        <article className="weq-qzn-post" key={person.id}>
          <QzonePersonHeader
            uin={person.uin}
            nickname={person.nickname}
            onSpace={space.onSpace}
            size={32}
            time={<QzoneTime value={person.time} />}
          />
        </article>
      ))}
      <PageEnd state={state} empty={empty} />
    </>
  );
}

function Guestbook({ space }: { space: Space }) {
  const state = useMorePages(space, 'guestbook', 0, (input, offset) =>
    client.account.qzone.guestbook.query({ ...input, offset }),
  );
  useMoreRefresh(state);
  return (
    <>
      {state.items.map((entry) => (
        <article className="weq-qzn-post" key={entry.id}>
          <QzonePersonHeader
            uin={entry.uin}
            nickname={entry.nickname}
            onSpace={space.onSpace}
            size={36}
            time={<QzoneTime value={entry.publishedAt} />}
          />
          <p className="weq-qzn-content" data-privacy-sensitive>
            <QzoneInlineText content={entry.text} />
          </p>
          {entry.replies.length ? (
            <section className="weq-qzn-interaction" aria-label="留言评论">
              {entry.replies.map((reply) => (
                <QzoneCommentRow
                  key={reply.id}
                  uin={reply.uin}
                  nickname={reply.nickname}
                  time={reply.time ?? 0}
                  onSpace={space.onSpace}
                >
                  <p data-privacy-sensitive>
                    <QzoneInlineText content={reply.text} />
                  </p>
                </QzoneCommentRow>
              ))}
            </section>
          ) : null}
        </article>
      ))}
      <PageEnd state={state} empty={state.first && !state.items.length ? '暂无留言' : ''} />
    </>
  );
}

function Videos({ space }: { space: Space }) {
  const state = useMorePages(space, 'videos', 0, (input, offset) =>
    client.account.qzone.videos.query({ ...input, offset }),
  );
  useMoreRefresh(state);
  return (
    <div className="weq-qzone-album-embedded">
      {state.items.length ? (
        <QzoneVideoGrid
          key={state.configId}
          selfUin={space.selfUin}
          hostUin={space.hostUin}
          configId={state.configId}
          videos={state.items}
          pageCount={state.pageCount}
        />
      ) : null}
      <PageEnd state={state} empty={state.first && !state.items.length ? '暂无视频' : ''} />
    </div>
  );
}

const moreComponents: Record<
  QzoneMorePane,
  (props: { space: Space; shareIndex: QzoneShareIndex }) => ReactNode
> = {
  shares: Shares,
  visitors: Visitors,
  guestbook: Guestbook,
  videos: Videos,
};

export function QzoneMore({
  pane,
  shareIndex,
  ...space
}: Space & { pane: QzoneMorePane; shareIndex: QzoneShareIndex }) {
  const Content = moreComponents[pane];
  return (
    <div className="weq-qzn-timeline">
      <Content space={space} shareIndex={shareIndex} />
    </div>
  );
}
