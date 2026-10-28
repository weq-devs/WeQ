/**
 * 空友爱看（公共空间）原生界面。
 *
 * 与「好友动态 / 我的空间 / 与我相关」并列的一栏：推荐域（domain_type 3）的动态
 * 走 h5 gotrpc，身份是 `cell_common.union_id`，和旧说说 tid 不通用，所以这里
 * 不链接到旧空间页，也不能用 tid 拼造互动目标 —— 每张卡片都揣着原始 feed 原件，
 * 详情与互动都整体回传。
 *
 * 复用空间页的媒体网格、预览、滚动保留与状态件（见 `qzoneShared.tsx`），
 * 只新增 feed / 评论这两套 `cell_*` 投影（`lib/qzonePublic.ts`）。
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  ChevronDown,
  Eye,
  Heart,
  Loader2,
  MessageCircle,
  RefreshCw,
  Repeat2,
  Send,
  ThumbsUp,
  UserPlus,
  UserCheck,
} from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from '../components/QqAvatar';
import { QzoneEmoji } from '../components/QzoneEmoji';
import { QzoneForwardDialog } from '../components/QzoneForwardDialog';
import { QzoneLikesPopover } from '../components/QzoneLikesPopover';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { qzoneTextParts } from '../lib/qzone';
import {
  mergePublicComments,
  projectPublicCommentsPage,
  projectPublicComment,
  projectPublicDetail,
  projectPublicFeed,
  projectPublicRepliesPage,
  publicCapabilities,
  type PublicCommentView,
  type PublicFeedView,
  type PublicJson,
} from '../lib/qzonePublic';
import { LoadingStatus, QzoneMediaGrid, QzonePageContext, State, timeText } from './qzoneShared';
import '../styles/qzone-public.css';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '加载失败，请重试。';

/** 大数字按中文习惯缩写：83911 → 8.4万。 */
function countText(value: number | null): string {
  if (value === null) return '?';
  if (value < 10_000) return String(value);
  return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
}

/** 正文里的 `[em]eXXX[/em]` 走表情图，其余按文本；不做 @ 跳转（公共域没有 uin）。 */
function PublicText({ content }: { content: string }) {
  return (
    <>
      {qzoneTextParts(content).map((part) =>
        part.kind === 'emoji' ? (
          <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
        ) : (
          // 公共域的作者没有 uin，@ 只能当普通文字显示，不做跳转。
          <span key={`${part.offset}:text`}>{part.text}</span>
        ),
      )}
    </>
  );
}

function toGridMedia(media: PublicFeedView['media']): {
  images: string[];
  videos: { coverUrl: string; videoUrl: string; videoId: string; duration: number }[];
} {
  return {
    images: media.filter((item) => item.kind === 'image').map((item) => item.src),
    videos: media
      .filter((item) => item.kind === 'video')
      .map((item) => ({
        coverUrl: item.poster,
        videoUrl: item.src,
        videoId: item.key,
        duration: item.durationMs,
      })),
  };
}

interface Capabilities {
  available: boolean;
  canUpvote: boolean;
  canFollow: boolean;
  canComment: boolean;
}

/**
 * 操作者身份。`publicUid` 是公共域里的作者标识（32 位十六进制），与本地
 * `u_xxx` 形式的 uid 不是一套 —— 只有发过评论 / 回复之后主进程才能从回执里学到它，
 * 所以在学到之前不显示删除入口。
 */
interface SelfIdentity {
  uin: string;
  uid: string;
  nick: string;
  publicUid: string;
}

/** 当前账号身份（uin / uid / nick），用于评论回显与「删除自己的评论」。 */
function useSelfIdentity(selfUin: string, enabled: boolean) {
  const [identity, setIdentity] = useState<SelfIdentity | null>(null);
  const [revision, setRevision] = useState(0);
  const requests = useQzoneRequests('qzonePublic');
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void requests
      .run((requestId) => client.account.qzonePublic.me.query({ selfUin, requestId }), true)
      .then((result) => {
        if (live) setIdentity(result);
      })
      .catch(() => {
        /* 昵称与 uid 拿不到时仍可浏览，只是删评入口不出现。 */
      });
    return () => {
      live = false;
      requests.cancel();
    };
  }, [selfUin, enabled, revision, requests]);
  /** 发过评论 / 回复之后重新读一次：主进程这时才学到公共域 uid。 */
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { identity, refresh };
}

export function QzonePublicPane({
  selfUin,
  onSpace,
}: {
  selfUin: string;
  /** 作者带 uin 时才能打开其旧空间页；公共域多数只有 uid。 */
  onSpace?: (uin: string, nickname?: string) => void;
}): ReactElement {
  const { active, refresh } = useContext(QzonePageContext);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const { identity, refresh: refreshIdentity } = useSelfIdentity(selfUin, active);
  // 每个 effect 各持一份 requestId 集合：`cancel()` 会清空**自己这一份**并通知主进程，
  // 共用一份的话，能力查询的 cleanup 会把推荐流的请求一起取消。
  const capabilityRequests = useQzoneRequests('qzonePublic');
  const feedRequests = useQzoneRequests('qzonePublic');
  const [feeds, setFeeds] = useState<PublicFeedView[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pageRequest, setPageRequest] = useState(0);
  const [done, setDone] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const nextCursor = useRef<string | null>(null);
  const seenCursors = useRef(new Set<string>());
  const moreRef = useRef<HTMLDivElement>(null);
  const nearEnd = useNearEnd(moreRef);

  // 能力查询：入口开关决定整栏是否可用，推权限决定是否显示「推」。
  //
  // 只跟「页面可见 / 账号 / 刷新代数」走，**不**跟翻页走 —— 之前两者共用一个
  // 计数器，翻一页就把能力重查一次，新的 capabilities 对象又让推荐流 effect 重跑，
  // 于是没人操作也会一直翻页刷新。
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setCapabilityError('');
    void capabilityRequests
      .run(
        (requestId) => client.account.qzonePublic.capabilities.query({ selfUin, requestId }),
        true,
      )
      .then((result) => {
        if (live) setCapabilities(publicCapabilities(result));
      })
      .catch((reason: unknown) => {
        if (live) setCapabilityError(errorText(reason));
      });
    return () => {
      live = false;
      capabilityRequests.cancel();
    };
  }, [active, selfUin, refresh, capabilityRetry, capabilityRequests]);

  // 首页与续页。刷新代数变化时回到首页，旧游标全部作废。
  //
  // 注意别把「刷新复位」放进另一个 effect：同一轮 commit 里拉取 effect 先跑，
  // 复位 effect 后跑，只会让这一页仍按旧游标读，还不会触发重拉。所以复位写在
  // 拉取 effect 自己的开头。
  const cursorRequest = useRef<string | null>(null);
  const lastRefresh = useRef(refresh);
  /** 上一次真正发出请求的游标，用来挡住「同一游标连发两次」。 */
  const requestedCursor = useRef<string | undefined>(undefined);
  /** 连续几次没拿到新内容就停，避免上游原地打转时无限续页。 */
  const stalledPages = useRef(0);
  const available = capabilities?.available ?? false;
  useEffect(() => {
    // 先确认入口：没有爱看入口的账号连推荐流都不该发。
    if (!active || !capabilities) return undefined;
    if (!available) {
      setFeeds(null);
      setDone(true);
      return undefined;
    }
    const refreshed = lastRefresh.current !== refresh;
    if (refreshed) {
      lastRefresh.current = refresh;
      cursorRequest.current = null;
      requestedCursor.current = undefined;
      seenCursors.current.clear();
      stalledPages.current = 0;
    }
    const pageCursor = cursorRequest.current;
    // 同一个游标已经发过就别再发一遍（重复渲染 / 依赖抖动都会走到这里）。
    if (pageCursor !== null && pageCursor === requestedCursor.current) return undefined;
    requestedCursor.current = pageCursor ?? undefined;
    const head = pageCursor === null;
    let live = true;
    setError('');
    setLoading(true);
    void feedRequests
      .run((requestId) =>
        client.account.qzonePublic.feeds.query({
          selfUin,
          requestId,
          ...(pageCursor === null ? {} : { cursor: pageCursor }),
        }),
      )
      .then((page) => {
        if (!live) return;
        const views = page.feeds
          .map((feed, index) => projectPublicFeed(feed, index))
          .filter((view): view is PublicFeedView => Boolean(view));
        let added = views.length;
        if (head) {
          setFeeds(views);
        } else {
          setFeeds((current) => {
            const merged = new Map((current ?? []).map((item) => [item.key, item]));
            const before = merged.size;
            for (const view of views) merged.set(view.key, view);
            added = merged.size - before;
            return [...merged.values()];
          });
        }
        const continuation =
          page.has_more && page.next_cursor && page.next_cursor !== pageCursor
            ? page.next_cursor
            : null;
        stalledPages.current = added === 0 && !head ? stalledPages.current + 1 : 0;
        // 上游原地打转（游标重复 / 连续空页）时就此停住。
        if (!continuation || stalledPages.current >= 3) {
          nextCursor.current = null;
          setDone(true);
          return;
        }
        if (seenCursors.current.has(continuation)) {
          nextCursor.current = null;
          setDone(true);
          return;
        }
        seenCursors.current.add(continuation);
        nextCursor.current = continuation;
        setDone(false);
      })
      .catch((reason: unknown) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      feedRequests.cancel();
    };
  }, [active, selfUin, refresh, pageRequest, available, capabilities, feedRequests]);

  // 触底自动续页；显式点「加载更多」走同一个入口。
  useEffect(() => {
    if (!active || !nearEnd || loading || error || done || !nextCursor.current) return undefined;
    const cursor = nextCursor.current;
    const timer = setTimeout(() => {
      if (nextCursor.current !== cursor) return;
      cursorRequest.current = cursor;
      setPageRequest((value) => value + 1);
    }, 350);
    return () => clearTimeout(timer);
  }, [active, nearEnd, loading, error, done]);

  const loadMore = useCallback(() => {
    if (!nextCursor.current || loading) return;
    cursorRequest.current = nextCursor.current;
    setPageRequest((value) => value + 1);
  }, [loading]);

  /** 回到首页重新读：刷新按钮和错误重试都走这里。 */
  const reload = useCallback(() => {
    if (loading) return;
    cursorRequest.current = null;
    requestedCursor.current = undefined;
    setPageRequest((value) => value + 1);
  }, [loading]);

  /** 本地更新单条动态（赞 / 推 / 关注后立即回显，失败由调用方回滚）。 */
  const patchFeed = useCallback((key: string, patch: Partial<PublicFeedView>) => {
    setFeeds(
      (current) =>
        current?.map((item) => (item.key === key ? { ...item, ...patch } : item)) ?? current,
    );
  }, []);

  if (capabilityError && !capabilities)
    return (
      <State
        loading={false}
        error={capabilityError}
        empty=""
        retry={() => setCapabilityRetry((value) => value + 1)}
      />
    );
  if (!capabilities) return <LoadingStatus text="正在确认空友爱看入口…" />;
  if (!capabilities.available)
    return (
      <div className="weq-qzn-timeline">
        <p className="weq-qzn-status">当前账号还没有开通空友爱看入口，暂时只能浏览原有空间内容。</p>
      </div>
    );

  return (
    <div className="weq-qzn-timeline weq-qzn-public">
      <div className="weq-qzn-section-title">
        <h2>空友爱看</h2>
        <button type="button" onClick={reload} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'weq-spin' : undefined} />
          刷新
        </button>
      </div>
      {!feeds ? <State loading={loading && !error} error={error} empty="" retry={reload} /> : null}
      {feeds?.map((feed) => (
        <PublicFeedCard
          key={feed.key}
          selfUin={selfUin}
          view={feed}
          capabilities={capabilities}
          identity={identity}
          onSpace={onSpace}
          onPatch={patchFeed}
          onWrote={refreshIdentity}
          expanded={openDetail === feed.key}
          onToggle={() => setOpenDetail(openDetail === feed.key ? null : feed.key)}
        />
      ))}
      <div ref={moreRef} className="weq-qzn-page-sentinel">
        {feeds && error ? (
          <State loading={false} error={error} empty="" retry={reload} />
        ) : feeds && !error ? (
          loading ? (
            <LoadingStatus text="正在加载…" />
          ) : !done ? (
            <button type="button" className="weq-qzn-more" onClick={loadMore}>
              加载更多推荐
            </button>
          ) : (
            <p className="weq-qzn-status">
              {feeds.length ? '已加载当前可查看的推荐' : '暂时没有可查看的推荐'}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

/** 与空间页同一套视口判定，但滚动容器是本页自己的。 */
function useNearEnd(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [near, setNear] = useState(false);
  const { active } = useContext(QzonePageContext);
  useEffect(() => {
    if (!active) {
      setNear(false);
      return undefined;
    }
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: element.closest('.weq-qzn-scroll'), rootMargin: '400px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return active && near;
}

function PublicFeedCard({
  selfUin,
  view,
  capabilities,
  identity,
  onSpace,
  onPatch,
  onWrote,
  expanded,
  onToggle,
}: {
  selfUin: string;
  view: PublicFeedView;
  capabilities: Capabilities;
  identity: SelfIdentity | null;
  onSpace?: (uin: string, nickname?: string) => void;
  onPatch: (key: string, patch: Partial<PublicFeedView>) => void;
  onWrote: () => void;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const [pending, setPending] = useState<'like' | 'upvote' | 'follow' | null>(null);
  const [error, setError] = useState('');
  const [forwardOpen, setForwardOpen] = useState(false);
  const grid = useMemo(() => toGridMedia(view.media), [view.media]);
  const canOpenSpace = /^[1-9]\d{4,19}$/.test(view.author.uin);
  const authorLabel = view.author.nick || view.author.uin || view.author.uid || '匿名用户';

  async function like(): Promise<void> {
    if (pending || !view.actionable) return;
    const next = !view.liked;
    const previousCount = view.likeCount;
    setPending('like');
    setError('');
    onPatch(view.key, {
      liked: next,
      likeCount: previousCount === null ? null : Math.max(0, previousCount + (next ? 1 : -1)),
    });
    try {
      await client.account.qzonePublic.like.mutate({ selfUin, feed: view.feed, enable: next });
    } catch (reason) {
      onPatch(view.key, { liked: !next, likeCount: previousCount });
      setError(errorText(reason));
    } finally {
      setPending(null);
    }
  }

  async function upvote(): Promise<void> {
    if (pending || !view.actionable) return;
    const next = !view.upvoted;
    setPending('upvote');
    setError('');
    onPatch(view.key, { upvoted: next });
    try {
      await client.account.qzonePublic.upvote.mutate({ selfUin, feed: view.feed, enable: next });
    } catch (reason) {
      onPatch(view.key, { upvoted: !next });
      setError(errorText(reason));
    } finally {
      setPending(null);
    }
  }

  async function follow(): Promise<void> {
    if (pending || !view.actionable) return;
    const next = !view.author.followed;
    setPending('follow');
    setError('');
    onPatch(view.key, { author: { ...view.author, followed: next } });
    try {
      await client.account.qzonePublic.follow.mutate({ selfUin, feed: view.feed, enable: next });
    } catch (reason) {
      onPatch(view.key, { author: { ...view.author, followed: !next } });
      setError(errorText(reason));
    } finally {
      setPending(null);
    }
  }

  return (
    <article className="weq-qzn-post weq-qzn-public-post">
      <header className="weq-qzn-post-head">
        {canOpenSpace && onSpace ? (
          <button
            type="button"
            aria-label={`进入 ${authorLabel} 的空间`}
            onClick={() => onSpace(view.author.uin, authorLabel)}
          >
            <QqAvatar uin={view.author.uin} url={view.author.portrait} size={36} />
          </button>
        ) : (
          <QqAvatar uin={null} url={view.author.portrait} size={36} />
        )}
        <div>
          <strong className="weq-qzn-public-name">{authorLabel}</strong>
          <time>{timeText(view.time)}</time>
        </div>
        {view.author.canFollow && capabilities.canFollow ? (
          <button
            type="button"
            className={`weq-qzn-public-follow${view.author.followed ? ' is-following' : ''}`}
            disabled={pending !== null}
            onClick={() => void follow()}
          >
            {pending === 'follow' ? (
              <Loader2 size={14} className="weq-spin" />
            ) : view.author.followed ? (
              <UserCheck size={14} />
            ) : (
              <UserPlus size={14} />
            )}
            {view.author.followed ? '已关注' : '关注'}
          </button>
        ) : null}
      </header>
      {view.text ? (
        <p className="weq-qzn-content">
          <PublicText content={view.text} />
        </p>
      ) : null}
      <QzoneMediaGrid images={grid.images} videos={grid.videos} />
      <div className="weq-qzn-actions weq-qzn-public-actions">
        <QzoneLikesPopover
          trigger={
            <button
              type="button"
              aria-pressed={view.liked}
              aria-label={view.liked ? '取消赞' : '赞'}
              disabled={!view.actionable || pending !== null}
              onClick={() => void like()}
            >
              <ThumbsUp size={16} fill={view.liked ? 'currentColor' : 'none'} />
              点赞 {countText(view.likeCount)}
            </button>
          }
        >
          <p className="weq-qzn-status">
            共 {countText(view.likeCount)} 人赞过 · 空友爱看点赞名单接口尚未接入
          </p>
        </QzoneLikesPopover>
        <button type="button" aria-expanded={expanded} aria-label="查看评论" onClick={onToggle}>
          <MessageCircle size={16} />
          评论 {countText(view.commentCount)}
        </button>
        <button type="button" aria-label="转发" onClick={() => setForwardOpen(true)}>
          <Repeat2 size={16} />
          转发 {countText(view.forwardCount)}
        </button>
        <button
          type="button"
          aria-pressed={view.upvoted}
          aria-label={view.upvoted ? '取消推' : '推'}
          disabled={!capabilities.canUpvote || !view.actionable || pending !== null}
          title={capabilities.canUpvote ? undefined : '当前账号不能推'}
          onClick={() => void upvote()}
        >
          <Heart size={16} fill={view.upvoted ? 'currentColor' : 'none'} />推 ?
        </button>
        <span title="浏览量（非去重访客数）">
          <Eye size={16} />
          浏览量 {countText(view.viewCount)}
        </span>
      </div>
      {error ? (
        <p className="weq-qzn-error" role="alert">
          {error}
        </p>
      ) : null}
      {expanded && view.actionable ? (
        <PublicFeedDetail
          selfUin={selfUin}
          view={view}
          identity={identity}
          canComment={capabilities.canComment}
          onCommentCount={(count) => onPatch(view.key, { commentCount: count })}
          onWrote={onWrote}
        />
      ) : null}
      {forwardOpen ? (
        <QzoneForwardDialog
          previousContent={view.text}
          unavailableReason="这条动态缺少互动标识，暂不能转发。"
          onClose={() => setForwardOpen(false)}
          submit={
            view.actionable
              ? async (reason) => {
                  await client.account.qzonePublic.forward.mutate({
                    selfUin,
                    feed: view.feed,
                    reason,
                  });
                  onPatch(view.key, {
                    forwardCount: view.forwardCount === null ? null : view.forwardCount + 1,
                  });
                }
              : undefined
          }
        >
          <strong>{authorLabel}</strong>
          <p className="weq-qzn-content">
            <PublicText content={view.text} />
          </p>
          <QzoneMediaGrid images={grid.images} videos={grid.videos} />
        </QzoneForwardDialog>
      ) : null}
    </article>
  );
}

function PublicFeedDetail({
  selfUin,
  view,
  identity,
  canComment,
  onCommentCount,
  onWrote,
}: {
  selfUin: string;
  view: PublicFeedView;
  identity: SelfIdentity | null;
  canComment: boolean;
  onCommentCount: (count: number) => void;
  /** 写成功回调：主进程这时才从回执里学到公共域 uid，需要重读身份。 */
  onWrote: () => void;
}): ReactElement {
  const { active } = useContext(QzonePageContext);
  const { run, cancel } = useQzoneRequests('qzonePublic');
  const [comments, setComments] = useState<PublicCommentView[] | null>(null);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState('');
  const composer = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [replyTarget, setReplyTarget] = useState<{
    comment: PublicCommentView;
    reply?: PublicCommentView;
  } | null>(null);
  useEffect(() => {
    composer.current?.focus();
    if (replyTarget) composer.current?.scrollIntoView({ block: 'nearest' });
  }, [replyTarget]);

  // 首批评论来自详情；之后的续页用 attach_info。
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setError('');
    setLoading(true);
    void run((requestId) =>
      client.account.qzonePublic.detail.query({ selfUin, requestId, feed: view.feed }),
    )
      .then((data) => {
        if (!live) return;
        const page = projectPublicDetail(data);
        setComments(page.comments);
        setCursor(page.cursor);
        setHasMore(page.hasMore);
      })
      .catch((reason: unknown) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [active, selfUin, view.feed, retry, run, cancel]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    void run((requestId) =>
      client.account.qzonePublic.comments.query({
        selfUin,
        requestId,
        feed: view.feed,
        cursor,
      }),
    )
      .then((data) => {
        const page = projectPublicCommentsPage(data);
        setComments((current) => mergePublicComments(current ?? [], page.comments));
        setCursor(page.cursor);
        setHasMore(page.hasMore);
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setLoading(false));
  }, [cursor, loading, run, selfUin, view.feed]);

  async function send(): Promise<void> {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError('');
    try {
      if (replyTarget) {
        const data = await client.account.qzonePublic.reply.mutate({
          selfUin,
          feed: view.feed,
          comment: replyTarget.comment.raw,
          content,
          ...(replyTarget.reply ? { reply: replyTarget.reply.raw } : {}),
        });
        const created = projectPublicComment(data.reply);
        if (created) {
          const parentId = replyTarget.comment.id;
          setComments(
            (current) =>
              current?.map((entry) =>
                entry.id === parentId ? { ...entry, replies: [...entry.replies, created] } : entry,
              ) ?? current,
          );
        }
      } else {
        const data = await client.account.qzonePublic.comment.mutate({
          selfUin,
          feed: view.feed,
          content,
        });
        const created = projectPublicComment(data.comment);
        if (created) {
          setComments((current) => [...(current ?? []), created]);
          onCommentCount((view.commentCount ?? 0) + 1);
        }
      }
      setDraft('');
      setReplyTarget(null);
      onWrote();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSending(false);
    }
  }

  async function remove(comment: PublicCommentView, reply?: PublicCommentView): Promise<void> {
    setError('');
    try {
      if (reply) {
        await client.account.qzonePublic.deleteReply.mutate({
          selfUin,
          feed: view.feed,
          comment: comment.raw,
          reply: reply.raw,
        });
        setComments(
          (current) =>
            current?.map((entry) =>
              entry.id === comment.id
                ? { ...entry, replies: entry.replies.filter((item) => item.id !== reply.id) }
                : entry,
            ) ?? current,
        );
      } else {
        await client.account.qzonePublic.deleteComment.mutate({
          selfUin,
          feed: view.feed,
          comment: comment.raw,
        });
        setComments((current) => current?.filter((entry) => entry.id !== comment.id) ?? current);
        onCommentCount(Math.max(0, (view.commentCount ?? 1) - 1));
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  // 只认公共域 uid（主进程从写回执里学到的那个），不拿本地 uid 硬比 ——
  // 两套标识不同，硬比只会把自己的评论标成别人的、或者反过来。
  const selfUid = identity?.publicUid ?? '';
  const mine = (comment: PublicCommentView): boolean =>
    Boolean(selfUid) && comment.author.uid === selfUid;

  return (
    <section className="weq-qzn-interaction weq-qzn-public-detail" aria-label="空友动态评论">
      {comments === null && loading ? <LoadingStatus text="正在加载评论…" /> : null}
      {error ? (
        <p className="weq-qzn-error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </p>
      ) : null}
      {comments !== null ? (
        <>
          <p className="weq-qzn-status">
            {view.commentCount === null ? '' : `共 ${countText(view.commentCount)} 条评论`}
          </p>
          {comments.map((comment) => (
            <div key={comment.id || comment.time} className="weq-qzn-public-comment">
              <div className="weq-qzn-comment">
                <QqAvatar uin={null} url={comment.author.portrait} size={26} />
                <div>
                  <span className="weq-qzn-public-name">
                    {comment.author.nick || comment.author.uin || '匿名用户'}
                  </span>
                  <p>
                    <PublicText content={comment.text} />
                  </p>
                  <QzoneMediaGrid images={toGridMedia(comment.media).images} />
                  <div className="weq-qzn-comment-meta">
                    <time>{timeText(comment.time)}</time>
                    <button
                      type="button"
                      onClick={() => setReplyTarget({ comment })}
                      disabled={!canComment}
                    >
                      回复
                    </button>
                    {mine(comment) ? (
                      <button type="button" onClick={() => void remove(comment)}>
                        删除
                      </button>
                    ) : null}
                    <CommentLike selfUin={selfUin} feed={view.feed} comment={comment} />
                  </div>
                </div>
              </div>
              {comment.replies.length ? (
                <div className="weq-qzn-public-replies">
                  {comment.replies.map((reply) => (
                    <div
                      key={reply.id || `${comment.id}:${reply.time}`}
                      className="weq-qzn-comment is-reply"
                    >
                      <QqAvatar uin={null} url={reply.author.portrait} size={22} />
                      <div>
                        <span className="weq-qzn-public-name">
                          {reply.author.nick || reply.author.uin || '匿名用户'}
                        </span>
                        <p>
                          <PublicText content={reply.text} />
                        </p>
                        <div className="weq-qzn-comment-meta">
                          <time>{timeText(reply.time)}</time>
                          <button
                            type="button"
                            onClick={() => setReplyTarget({ comment, reply })}
                            disabled={!canComment}
                          >
                            回复
                          </button>
                          {mine(reply) ? (
                            <button type="button" onClick={() => void remove(comment, reply)}>
                              删除
                            </button>
                          ) : null}
                          <CommentLike
                            selfUin={selfUin}
                            feed={view.feed}
                            comment={comment}
                            reply={reply}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <ReplyMore
                    selfUin={selfUin}
                    feed={view.feed}
                    comment={comment}
                    onLoaded={(replies) =>
                      setComments(
                        (current) =>
                          current?.map((entry) =>
                            entry.id === comment.id
                              ? { ...entry, replies: [...entry.replies, ...replies] }
                              : entry,
                          ) ?? current,
                      )
                    }
                  />
                </div>
              ) : null}
            </div>
          ))}
          {hasMore ? (
            <button type="button" className="weq-qzn-more" disabled={loading} onClick={loadMore}>
              {loading ? '正在加载…' : '加载更多评论'}
            </button>
          ) : comments.length === 0 ? (
            <p className="weq-qzn-status">还没有评论</p>
          ) : null}
        </>
      ) : null}
      {canComment ? (
        <div className="weq-qzn-public-composer">
          {replyTarget ? (
            <p className="weq-qzn-status">
              回复 {replyTarget.reply?.author.nick || replyTarget.comment.author.nick || '这条评论'}
              <button type="button" onClick={() => setReplyTarget(null)}>
                取消
              </button>
            </p>
          ) : null}
          <div>
            <input
              ref={composer}
              aria-label={replyTarget ? '回复内容' : '评论内容'}
              placeholder={replyTarget ? '写下回复…' : '写下评论…'}
              value={draft}
              maxLength={4096}
              disabled={sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="button"
              className="weq-qzn-primary"
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
            >
              {sending ? <Loader2 size={15} className="weq-spin" /> : <Send size={15} />}
              {replyTarget ? '回复' : '评论'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 单条评论 / 回复的点赞；`like.id` 原样回传，不自己拼。 */
function CommentLike({
  selfUin,
  feed,
  comment,
  reply,
}: {
  selfUin: string;
  feed: PublicJson;
  comment: PublicCommentView;
  reply?: PublicCommentView;
}) {
  const target = reply ?? comment;
  const [liked, setLiked] = useState(target.liked);
  const [count, setCount] = useState(target.likeCount);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLiked(target.liked);
    setCount(target.likeCount);
  }, [target.liked, target.likeCount]);
  async function toggle(): Promise<void> {
    if (busy) return;
    const next = !liked;
    setBusy(true);
    setLiked(next);
    setCount((value) => Math.max(0, value + (next ? 1 : -1)));
    try {
      await client.account.qzonePublic.commentLike.mutate({
        selfUin,
        feed,
        comment: comment.raw,
        enable: next,
        ...(reply ? { reply: reply.raw } : {}),
      });
    } catch {
      setLiked(!next);
      setCount((value) => Math.max(0, value + (next ? -1 : 1)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="weq-qzn-public-comment-like"
      aria-pressed={liked}
      aria-label={liked ? '取消赞' : '赞'}
      disabled={busy}
      onClick={() => void toggle()}
    >
      <ThumbsUp size={13} fill={liked ? 'currentColor' : 'none'} />
      {count > 0 ? count : ''}
    </button>
  );
}

/** 首屏之外的回复：评论自带 reply_attach_info，续页用上一页的游标。 */
function ReplyMore({
  selfUin,
  feed,
  comment,
  onLoaded,
}: {
  selfUin: string;
  feed: PublicJson;
  comment: PublicCommentView;
  onLoaded: (replies: PublicCommentView[]) => void;
}) {
  const [cursor, setCursor] = useState(comment.replyCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const remaining = comment.replyCount - comment.replies.length;
  if (remaining <= 0) return null;
  async function load(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await client.account.qzonePublic.replies.query({
        selfUin,
        feed,
        comment: comment.raw,
        cursor,
        requestId: crypto.randomUUID(),
      });
      const page = projectPublicRepliesPage(data, comment.id);
      onLoaded(page.replies);
      setCursor(page.cursor);
      if (!page.hasMore || page.replies.length === 0) setDone(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error ? <p className="weq-qzn-error">{error}</p> : null}
      {!done ? (
        <button
          type="button"
          className="weq-qzn-public-more-replies"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? <Loader2 size={13} className="weq-spin" /> : <ChevronDown size={13} />}
          展开更多回复（{remaining}）
        </button>
      ) : null}
    </>
  );
}
