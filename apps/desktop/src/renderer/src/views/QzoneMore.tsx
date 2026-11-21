import { useInfiniteQuery } from '@tanstack/react-query';
import type { QzoneShare, QzoneShareCategory } from '@weqbot/protocol/web';
import { RefreshCw } from 'lucide-react';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { FormSelect } from '../components/FormSelect';
import { QzoneActionsRow, QzoneCommentToggle } from '../components/QzoneActionsRow';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { QzoneFeedLinks } from '../components/QzoneFeedLinks';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { qzoneLinkTarget, qzoneMediaSource } from '../lib/qzone';
import { client, trpc } from '../trpc/client';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext, timeText, useNearViewport } from './qzoneShared.shared';
import { QzoneVideoGrid } from './QzoneVideoGrid';

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

export const moreSpacePanes = {
  shares: '分享',
  visitors: '访客',
  guestbook: '留言板',
  videos: '视频',
};
export type QzoneMorePane = keyof typeof moreSpacePanes;

type Space = {
  selfUin: string;
  hostUin: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
};
type Request = Pick<Space, 'selfUin' | 'hostUin'> & {
  requestId: string;
  expectedAccountConfigId: string;
};
type Page = { items: { id: string }[]; next: number | null };

function useSpaceRequest({ selfUin, hostUin }: Pick<Space, 'selfUin' | 'hostUin'>) {
  const { active, refresh } = useContext(QzonePageContext);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const configId = config.data?.uin === selfUin ? config.data.configId : '';
  return {
    active,
    refresh,
    error: config.error,
    retryConfig: config.refetch,
    configId,
    target: { selfUin, hostUin, expectedAccountConfigId: configId || '' },
  };
}

function useMorePages<P extends Page>(
  space: Pick<Space, 'selfUin' | 'hostUin'>,
  key: string,
  start: number,
  load: (input: Request, offset: number) => Promise<P>,
  staleTime?: number,
) {
  const { active, refresh, configId, target, error, retryConfig } = useSpaceRequest(space);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const query = useInfiniteQuery({
    queryKey: ['qzone-more', target, key, refresh],
    enabled: active && Boolean(configId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime,
    queryFn: ({ pageParam = start, signal }) =>
      run((requestId) => load({ ...target, requestId }, pageParam), false, signal),
    getNextPageParam: (last: P, pages: P[]) => {
      if (!last.items.length || last.next === null) return undefined;
      if (pages.length > 1) {
        const preceding = new Set(
          pages.slice(0, -1).flatMap((page) => page.items.map(({ id }) => id)),
        );
        if (last.items.every(({ id }) => preceding.has(id))) return undefined;
      }
      return last.next;
    },
  });
  const pages = query.data?.pages ?? [];
  const items = new Map<string, P['items'][number]>();
  for (const page of pages) {
    for (const item of page.items as P['items']) if (!items.has(item.id)) items.set(item.id, item);
  }
  const failure = error ?? query.error;
  return {
    first: pages[0],
    pageCount: pages.length,
    configId,
    items: [...items.values()] as P['items'],
    error: failure instanceof Error ? failure.message : failure ? '读取失败，请重试。' : '',
    loading: query.isFetching || (active && !configId && !error),
    onNext:
      active && query.hasNextPage
        ? () => void query.fetchNextPage({ cancelRefetch: false })
        : undefined,
    onRetry: () =>
      void (error ? retryConfig() : query.hasNextPage ? query.fetchNextPage() : query.refetch()),
  };
}

type PagedState = Pick<ReturnType<typeof useMorePages>, 'error' | 'loading' | 'onNext' | 'onRetry'>;

function PageEnd({ state, empty }: { state: PagedState; empty: string }) {
  return state.loading || state.error || empty ? (
    <State loading={state.loading} error={state.error} retry={state.onRetry} empty={empty} />
  ) : state.onNext ? (
    <div className="weq-qzn-page-sentinel">
      <button type="button" className="weq-set-btn" onClick={state.onNext}>
        加载更多
      </button>
    </div>
  ) : null;
}

function Shares({ space }: { space: Space }) {
  const [category, setCategory] = useState<QzoneShareCategory>(0);
  const state = useMorePages(space, `shares:${category}`, 1, (input, page) =>
    client.account.qzone.shares.query({ ...input, category, page }),
  );
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
        <SharePost key={share.id} space={space} share={share} />
      ))}
      <PageEnd state={state} empty={state.first && !state.items.length ? '这个分类暂无分享' : ''} />
    </>
  );
}

function SharePost({ space, share }: { space: Space; share: QzoneShare }) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const href = qzoneLinkTarget(share.originalUrl);
  const cover = qzoneMediaSource(share.previewUrl);
  const title = share.title || '分享';
  return (
    <article className="weq-qzn-post">
      <header className="weq-qzn-post-head">
        <QzonePersonHeader
          uin={space.hostUin}
          nickname={space.nickname || space.hostUin}
          onSpace={space.onSpace}
          size={34}
          time={share.publishedAt ? <time>{share.publishedAt}</time> : null}
        />
      </header>
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
      <QzoneActionsRow>
        <QzoneCommentToggle
          expanded={commentsOpen}
          count={commentCount}
          onToggle={() => setCommentsOpen((open) => !open)}
        />
      </QzoneActionsRow>
      {commentsOpen ? (
        <ShareCommentList space={space} shareId={share.id} onCount={setCommentCount} />
      ) : null}
    </article>
  );
}

function ShareCommentList({
  space,
  shareId,
  onCount,
}: {
  space: Space;
  shareId: string;
  onCount: (count: number) => void;
}) {
  const { first, items, loading, error, onNext, onRetry } = useMorePages(
    space,
    `share-comments:${shareId}`,
    1,
    (input, page) => client.account.qzone.shareComments.query({ ...input, shareId, page }),
    60_000,
  );
  const count = first?.total;
  useEffect(() => {
    if (count !== undefined) onCount(count);
  }, [count, onCount]);
  const more = useRef<HTMLDivElement>(null);
  const nearEnd = useNearViewport(more, false, Boolean(onNext) && !error);
  useEffect(() => {
    if (nearEnd && !loading && !error) onNext?.();
  }, [nearEnd, loading, error, onNext]);
  return (
    <section className="weq-qzn-interaction" aria-label="分享评论">
      {count === 0 && !loading && !error ? <p className="weq-qzn-status">暂无评论</p> : null}
      {items.map((row) => (
        <div key={row.id}>
          {[row, ...row.replies].map((comment, index) => (
            <QzoneCommentRow
              key={comment.id}
              uin={comment.uin}
              nickname={comment.nickname}
              time={0}
              onSpace={space.onSpace}
              className={index > 0 ? 'is-reply' : undefined}
              afterMeta={
                comment.publishedAt ? (
                  <div className="weq-qzn-comment-meta">
                    <time>{comment.publishedAt}</time>
                  </div>
                ) : null
              }
            >
              <p data-privacy-sensitive>
                <QzoneInlineText content={comment.text} />
              </p>
            </QzoneCommentRow>
          ))}
        </div>
      ))}
      {loading ? <LoadingStatus text="正在加载评论…" /> : null}
      {error ? (
        <p className="weq-qzn-error" role="status">
          {error}{' '}
          <button type="button" className="weq-retry-button" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden />
            重试
          </button>
        </p>
      ) : null}
      {onNext && !error ? <div ref={more} className="weq-qzn-page-sentinel" /> : null}
    </section>
  );
}

function Visitors({ space }: { space: Space }) {
  const state = useMorePages(space, 'visitors', 1, (input, page) =>
    client.account.qzone.visitors.query({ ...input, page }),
  );
  const first = state.first;
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
            time={<time>{timeText(person.time)}</time>}
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
  return (
    <>
      {state.items.map((entry) => (
        <article className="weq-qzn-post" key={entry.id}>
          <QzonePersonHeader
            uin={entry.uin}
            nickname={entry.nickname}
            onSpace={space.onSpace}
            size={36}
            time={<time>{entry.publishedAt}</time>}
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

const moreComponents: Record<QzoneMorePane, (props: { space: Space }) => ReactNode> = {
  shares: Shares,
  visitors: Visitors,
  guestbook: Guestbook,
  videos: Videos,
};

export function QzoneMore({ pane, ...space }: Space & { pane: QzoneMorePane }) {
  const Content = moreComponents[pane];
  return (
    <div className="weq-qzn-timeline">
      <Content space={space} />
    </div>
  );
}
