import { useInfiniteQuery } from '@tanstack/react-query';
import type { QzoneShareCategory } from '@weqbot/protocol/web';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { openExternalLink } from '../lib/openExternalLink';
import { qzoneLinkTarget, qzoneMediaSource } from '../lib/qzone';
import { client, trpc } from '../trpc/client';
import { QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext, timeText } from './qzoneShared.shared';
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
    onNext: active && query.hasNextPage ? () => void query.fetchNextPage() : undefined,
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

function ShareExport({
  space,
  category,
  enabled,
}: {
  space: Space;
  category: QzoneShareCategory;
  enabled: boolean;
}) {
  const { target, active } = useSpaceRequest(space);
  const { run } = useQzoneRequests();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <>
      <button
        type="button"
        className="weq-set-btn"
        disabled={!active || !enabled || pending}
        onClick={(event) => {
          const ownerDocument = event.currentTarget.ownerDocument;
          setPending(true);
          setMessage('');
          void run(
            (requestId) =>
              client.account.qzone.exportShares.mutate({ ...target, category, requestId }),
            true,
          )
            .then((result) => {
              if (!result) return;
              if (result.downloadUrl) {
                const anchor = ownerDocument.createElement('a');
                anchor.href = result.downloadUrl;
                anchor.download = '';
                anchor.click();
              }
              setMessage(
                result.downloadUrl
                  ? `已导出 ${result.count} 条分享`
                  : `已导出 ${result.count} 条分享至 ${result.path}`,
              );
            })
            .catch((error: unknown) =>
              setMessage(error instanceof Error ? error.message : '导出分享失败。'),
            )
            .finally(() => setPending(false));
        }}
      >
        {pending ? '正在导出…' : '导出此分类'}
      </button>
      {message ? (
        <span role="status" className="weq-qzn-export-status">
          {message}
        </span>
      ) : null}
    </>
  );
}

function Shares({ space }: { space: Space }) {
  const [category, setCategory] = useState<QzoneShareCategory>(0);
  const state = useMorePages(space, `shares:${category}`, 1, (input, page) =>
    client.account.qzone.shares.query({ ...input, category, page }),
  );
  return (
    <>
      <div className="weq-qzn-more-toolbar">
        <select
          aria-label="分享分类"
          className="weq-set-input"
          value={category}
          onChange={(event) => setCategory(Number(event.target.value) as QzoneShareCategory)}
        >
          {Object.entries(shareCategories).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <ShareExport space={space} category={category} enabled={state.items.length > 0} />
      </div>
      {state.items.map((share) => {
        const href = qzoneLinkTarget(share.originalUrl);
        const poster = qzoneMediaSource(share.previewUrl);
        return (
          <article className="weq-qzn-post" key={share.id}>
            <header className="weq-qzn-post-head">
              <h3 className="weq-qzn-more-title" data-privacy-sensitive>
                {share.title || '分享'}
              </h3>
              {share.publishedAt ? <time>{share.publishedAt}</time> : null}
            </header>
            {share.memo ? (
              <p className="weq-qzn-content" data-privacy-sensitive>
                <QzoneInlineText content={share.memo} />
              </p>
            ) : null}
            {poster ? <QzoneMediaGrid images={[poster]} videos={[]} /> : null}
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalLink(href);
                }}
              >
                打开原链接
              </a>
            ) : null}
            <ShareComments space={space} shareId={share.id} />
          </article>
        );
      })}
      <PageEnd state={state} empty={state.first && !state.items.length ? '这个分类暂无分享' : ''} />
    </>
  );
}

function ShareComments({ space, shareId }: { space: Space; shareId: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="weq-qzn-share-comments">
      <button
        type="button"
        className="weq-set-btn"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '收起评论' : '查看评论'}
      </button>
      {expanded ? <ShareCommentList space={space} shareId={shareId} /> : null}
    </div>
  );
}

function ShareCommentList({ space, shareId }: { space: Space; shareId: string }) {
  const state = useMorePages(space, `share-comments:${shareId}`, 1, (input, page) =>
    client.account.qzone.shareComments.query({ ...input, shareId, page }),
  );
  return (
    <div className="weq-qzn-comments" aria-label="分享评论">
      {state.items.map((row) => (
        <QzoneCommentRow
          key={row.id}
          uin={row.uin}
          nickname={row.nickname}
          time={0}
          onSpace={space.onSpace}
          afterMeta={<time>{row.publishedAt}</time>}
        >
          <div className="weq-qzn-comment-content" data-privacy-sensitive>
            <QzoneInlineText content={row.text} />
          </div>
          {row.replies.map((reply) => (
            <QzoneCommentRow
              key={reply.id}
              uin={reply.uin}
              nickname={reply.nickname}
              time={0}
              onSpace={space.onSpace}
              afterMeta={<time>{reply.publishedAt}</time>}
            >
              <div className="weq-qzn-comment-content" data-privacy-sensitive>
                <QzoneInlineText content={reply.text} />
              </div>
            </QzoneCommentRow>
          ))}
        </QzoneCommentRow>
      ))}
      <PageEnd state={state} empty={state.first && !state.items.length ? '暂无评论' : ''} />
    </div>
  );
}

function Visitors({ space }: { space: Space }) {
  const state = useMorePages(space, 'visitors', 1, (input, page) =>
    client.account.qzone.visitors.query({ ...input, page }),
  );
  const first = state.first;
  const count = (value: number | null) => (value === null ? '未知' : value.toLocaleString('zh-CN'));
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
      {first && (first.totalCount !== null || first.todayCount !== null) ? (
        <div className="weq-qzn-space-stats" aria-label="空间浏览量">
          <dl>
            <div>
              <dt>总浏览量</dt>
              <dd>{count(first.totalCount)}</dd>
            </div>
            <div>
              <dt>今日浏览量</dt>
              <dd>{count(first.todayCount)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
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
      {state.first?.greeting ? (
        <section aria-label="主人寄语">
          <h3 className="weq-qzn-more-title">主人寄语</h3>
          <p className="weq-qzn-content" data-privacy-sensitive>
            <QzoneInlineText content={state.first.greeting} />
          </p>
        </section>
      ) : null}
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
