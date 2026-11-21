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
import { NumericText } from '../components/NumericText';
import { EmptyState } from '../components/EmptyState';
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
  Eye,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  ThumbsUp,
  UserPlus,
  UserCheck,
  X,
  Images,
} from 'lucide-react';
import { useSearchTargetFocus } from '../hooks/useSearchTargetFocus';
import type { ContentSearchTarget } from '../components/search/types';
import { client } from '../trpc/client';
import { normalizeQzonePublicRefreshCooldown } from '@weq/service/qzone-public-settings';
import { PageDataCache } from '../lib/pageDataCache';
import { QqAvatar } from '../components/QqAvatar';
import { QzonePersonIdentity, QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { QzoneInlineText } from '../components/QzoneEmoji';
import { QzoneForwardDialog } from '../components/QzoneForwardDialog';
import { QzoneActionsRow } from '../components/QzoneActionsRow';
import { QzoneForwardAction } from '../components/QzoneForwardAction';
import { QzoneLikesPopover } from '../components/QzoneLikesPopover';
import { QzoneUpvoteAction } from '../components/QzoneUpvoteAction';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import {
  mergePublicComments,
  projectPublicCommentsPage,
  projectPublicComment,
  projectPublicDetail,
  projectPublicFeed,
  projectPublicRepliesPage,
  publicCapabilities,
  publicGridMedia,
  type PublicCommentView,
  type PublicFeedView,
  type PublicJson,
} from '../lib/qzonePublic';
import { QzoneAutoPage, QzonePageButton } from './QzonePagination';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import { QzonePageContext, timeText } from './qzoneShared.shared';
import '../styles/qzone-public.css';
import '../styles/qzone.css';

type PublicCommentFocus = { commentId: string; parentCommentId?: string };

export function QzonePublicSearchResult({
  selfUin,
  target,
  onClose,
}: {
  selfUin: string;
  target: Extract<ContentSearchTarget, { kind: 'qzonePublicComment' }>;
  onClose: () => void;
}) {
  const requests = useQzoneRequests('qzonePublic');
  const capabilitiesRequests = useQzoneRequests('qzonePublic');
  const { identity, refresh } = useSelfIdentity(selfUin, true);
  const [capabilities, setCapabilities] = useState(() => publicCapabilities(null));
  const [view, setView] = useState<PublicFeedView | null>(null);
  const [detail, setDetail] = useState<PublicJson | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    let active = true;
    setError('');
    void requests
      .run((requestId) =>
        client.account.qzonePublic.detail.query({ selfUin, requestId, feed: target.feed }),
      )
      .then((data) => {
        if (!active) return;
        const actual = (data as { feed?: { feed?: unknown } }).feed?.feed;
        const next = projectPublicFeed(actual);
        if (!next) throw new Error('对应动态已移除或当前无法读取');
        setView(next);
        setDetail(data);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
      requests.cancel();
    };
  }, [requests, selfUin, target.feed, retry]);
  useEffect(() => {
    let active = true;
    void capabilitiesRequests
      .run((requestId) => client.account.qzonePublic.capabilities.query({ selfUin, requestId }))
      .then((data) => {
        if (active) setCapabilities(publicCapabilities(data));
      })
      .catch(() => undefined);
    return () => {
      active = false;
      capabilitiesRequests.cancel();
    };
  }, [capabilitiesRequests, selfUin]);
  return (
    <div>
      <header className="weq-tools-header">
        <h2 id="weq-public-comment-search-title">空友评论</h2>
        <button
          type="button"
          className="weq-set-iconbtn"
          title="关闭"
          aria-label="关闭空友评论"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="weq-qzn-public-search">
        {view && detail ? (
          <PublicFeedCard
            selfUin={selfUin}
            view={view}
            capabilities={capabilities}
            identity={identity}
            onPatch={(_key, patch) =>
              setView((current) => (current ? { ...current, ...patch } : current))
            }
            onWrote={refresh}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            initialDetail={detail}
            focusComment={target}
          />
        ) : (
          <State
            loading={!error}
            error={error}
            empty=""
            retry={() => setRetry((value) => value + 1)}
          />
        )}
      </div>
    </div>
  );
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '加载失败，请重试。';

/** 大数字按中文习惯缩写：83911 → 8.4万。 */
function countText(value: number | null): string {
  if (value === null) return '?';
  if (value < 10_000) return String(value);
  return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
}

interface Capabilities {
  available: boolean;
  canUpvote: boolean;
  canFollow: boolean;
  canComment: boolean;
}

interface PublicFeedSnapshot {
  feeds: PublicFeedView[];
  done: boolean;
  nextCursor: string | null;
  seenCursors: string[];
  stalledPages: number;
  headLoadedAt: number;
}

// 仅本次运行保留推荐与游标，不写磁盘；复用有容量上限的页面缓存。
const publicFeedCache = new PageDataCache(8, 8 * 1024 * 1024, Infinity);

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
  return <QzonePublicContent key={selfUin} selfUin={selfUin} onSpace={onSpace} />;
}

function QzonePublicContent({
  selfUin,
  onSpace,
}: {
  selfUin: string;
  onSpace?: (uin: string, nickname?: string) => void;
}): ReactElement {
  const { active, refresh } = useContext(QzonePageContext);
  const [snapshot] = useState(() => publicFeedCache.get<PublicFeedSnapshot>(selfUin));
  const [cooldownMinutes, setCooldownMinutes] = useState<number | null>(null);
  const headLoadedAt = useRef(snapshot?.headLoadedAt ?? null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const { identity, refresh: refreshIdentity } = useSelfIdentity(selfUin, active);
  // 每个 effect 各持一份 requestId 集合：`cancel()` 会清空**自己这一份**并通知主进程，
  // 共用一份的话，能力查询的 cleanup 会把推荐流的请求一起取消。
  const capabilityRequests = useQzoneRequests('qzonePublic');
  const feedRequests = useQzoneRequests('qzonePublic');
  const [feeds, setFeeds] = useState<PublicFeedView[] | null>(snapshot?.feeds ?? null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pageRequest, setPageRequest] = useState(0);
  const [done, setDone] = useState(snapshot?.done ?? false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const nextCursor = useRef<string | null>(snapshot?.nextCursor ?? null);
  const seenCursors = useRef(new Set(snapshot?.seenCursors));
  const seenFeedKeys = useRef(new Set(snapshot?.feeds.map((feed) => feed.key)));

  // 能力查询：入口开关决定整栏是否可用，推权限决定是否显示「推」。
  //
  // 只跟「页面可见 / 账号 / 刷新代数」走，**不**跟翻页走 —— 之前两者共用一个
  // 计数器，翻一页就把能力重查一次，新的 capabilities 对象又让推荐流 effect 重跑，
  // 于是没人操作也会一直翻页刷新。
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    setCapabilityError('');
    void Promise.all([
      capabilityRequests.run(
        (requestId) => client.account.qzonePublic.capabilities.query({ selfUin, requestId }),
        true,
      ),
      client.bootstrap.getSettings.query(),
    ])
      .then(([result, settings]) => {
        if (!live) return;
        setCooldownMinutes(
          normalizeQzonePublicRefreshCooldown(settings.qzonePublicRefreshCooldownMinutes),
        );
        setCapabilities(publicCapabilities(result));
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
  const lastRefresh = useRef<number | undefined>(undefined);
  /** 上一次真正发出请求的游标，用来挡住「同一游标连发两次」。 */
  const requestedCursor = useRef<string | null | undefined>(snapshot ? null : undefined);
  /** 连续几次没拿到新内容就停，避免上游原地打转时无限续页。 */
  const stalledPages = useRef(snapshot?.stalledPages ?? 0);
  const available = capabilities?.available;
  useEffect(() => {
    // 先确认入口：没有爱看入口的账号连推荐流都不该发。
    if (!active) {
      lastRefresh.current = undefined;
      return undefined;
    }
    if (available === undefined || cooldownMinutes === null) return undefined;
    if (!available) {
      setFeeds(null);
      setDone(true);
      return undefined;
    }
    const refreshed = lastRefresh.current !== refresh;
    if (refreshed) {
      lastRefresh.current = refresh;
      const age = headLoadedAt.current === null ? null : Date.now() - headLoadedAt.current;
      if (age !== null && age >= 0 && age < cooldownMinutes * 60_000) {
        setLoading(false);
        return undefined;
      }
      cursorRequest.current = null;
      requestedCursor.current = undefined;
      seenCursors.current.clear();
      stalledPages.current = 0;
    }
    const pageCursor = cursorRequest.current;
    // 同一个游标已经发过就别再发一遍（重复渲染 / 依赖抖动都会走到这里）。
    if (pageCursor === requestedCursor.current) return undefined;
    requestedCursor.current = pageCursor;
    const head = pageCursor === null;
    let live = true;
    let completed = false;
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
        if (head) seenFeedKeys.current.clear();
        const previousSize = seenFeedKeys.current.size;
        for (const view of views) seenFeedKeys.current.add(view.key);
        const added = seenFeedKeys.current.size - previousSize;
        if (head) {
          headLoadedAt.current = Date.now();
          setFeeds(views);
        } else {
          setFeeds((current) => {
            const merged = new Map((current ?? []).map((item) => [item.key, item]));
            for (const view of views) merged.set(view.key, view);
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
        completed = true;
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      if (!completed) requestedCursor.current = undefined;
      feedRequests.cancel();
    };
  }, [active, selfUin, refresh, pageRequest, available, cooldownMinutes, feedRequests]);

  useEffect(() => {
    if (feeds === null || headLoadedAt.current === null) return;
    publicFeedCache.put(selfUin, {
      feeds,
      done,
      nextCursor: nextCursor.current,
      seenCursors: [...seenCursors.current],
      stalledPages: stalledPages.current,
      headLoadedAt: headLoadedAt.current,
    } satisfies PublicFeedSnapshot);
  }, [selfUin, feeds, done]);

  const loadMore = useCallback(() => {
    if (!nextCursor.current || loading) return;
    cursorRequest.current = nextCursor.current;
    setPageRequest((value) => value + 1);
  }, [loading]);

  /** 手动换一批与错误重试不受自动刷新冷却限制。 */
  const reload = useCallback(() => {
    if (loading) return;
    cursorRequest.current = null;
    requestedCursor.current = undefined;
    seenCursors.current.clear();
    stalledPages.current = 0;
    nextCursor.current = null;
    setDone(false);
    setPageRequest((value) => value + 1);
  }, [loading]);
  const retryPage = () => {
    requestedCursor.current = undefined;
    setPageRequest((value) => value + 1);
  };

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
          换一批
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
      <div className="weq-qzn-page-sentinel">
        {feeds && error ? (
          <State loading={false} error={error} empty="" retry={retryPage} />
        ) : feeds && !error ? (
          loading ? (
            <LoadingStatus text="正在加载…" />
          ) : !done && nextCursor.current ? (
            <QzoneAutoPage key={nextCursor.current} loading={false} delay={350} onNext={loadMore} />
          ) : feeds.length ? (
            <p className="weq-qzn-status">已加载当前可查看的推荐</p>
          ) : (
            <EmptyState icon={<Images />} title="暂时没有可查看的推荐" />
          )
        ) : null}
      </div>
    </div>
  );
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
  initialDetail,
  focusComment,
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
  initialDetail?: PublicJson;
  focusComment?: PublicCommentFocus;
}): ReactElement {
  const [pending, setPending] = useState<'like' | 'upvote' | 'follow' | null>(null);
  const [error, setError] = useState('');
  const [forwardOpen, setForwardOpen] = useState(false);
  const grid = useMemo(() => publicGridMedia(view.media), [view.media]);
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
    const previous = view.upvote;
    const users = (previous?.users ?? []).filter(
      (user) => user.uin !== selfUin && (!identity?.publicUid || user.uid !== identity.publicUid),
    );
    if (next && identity)
      users.unshift({
        uin: selfUin,
        uid: identity.publicUid,
        nickname: identity.nick,
      });
    setPending('upvote');
    setError('');
    onPatch(view.key, {
      upvoted: next,
      upvote: {
        count: previous?.count == null ? null : Math.max(0, previous.count + (next ? 1 : -1)),
        upvoted: next,
        users,
      },
    });
    try {
      await client.account.qzonePublic.upvote.mutate({ selfUin, feed: view.feed, enable: next });
    } catch (reason) {
      onPatch(view.key, { upvoted: !next, upvote: previous });
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
        <QzonePersonHeader
          size={36}
          url={view.author.portrait}
          uin={canOpenSpace ? view.author.uin : null}
          nickname={authorLabel}
          onSpace={onSpace}
          time={
            <time>
              <NumericText>{timeText(view.time)}</NumericText>
            </time>
          }
        />
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
          <QzoneInlineText content={view.text} />
        </p>
      ) : null}
      <QzoneMediaGrid images={grid.images} videos={grid.videos} />
      <QzoneActionsRow>
        <QzoneLikesPopover
          trigger={
            <button
              type="button"
              aria-pressed={view.liked}
              aria-label={view.liked ? '取消点赞' : '点赞'}
              aria-busy={pending === 'like'}
              disabled={!view.actionable || pending !== null}
              onClick={() => void like()}
            >
              {pending === 'like' ? (
                <Loader2 size={16} className="weq-spin" />
              ) : (
                <ThumbsUp size={16} fill={view.liked ? 'currentColor' : 'none'} />
              )}
              <span className="weq-qzn-action-label">点赞</span>{' '}
              <span className="weq-number">{countText(view.likeCount)}</span>
            </button>
          }
        >
          <p className="weq-qzn-status">
            {view.likeCount === 0
              ? '还没有人点赞'
              : view.likeCount === null
                ? '暂无法查看点赞名单'
                : `共 ${view.likeCount} 人点赞，暂无法查看名单`}
          </p>
        </QzoneLikesPopover>
        <button type="button" aria-expanded={expanded} aria-label="查看评论" onClick={onToggle}>
          <MessageCircle size={16} />
          <span className="weq-qzn-action-label">评论</span>{' '}
          <span className="weq-number">{countText(view.commentCount)}</span>
        </button>
        <QzoneForwardAction
          count={view.forwardCount}
          message={view.forwardCount === 0 ? '还没有人转发' : '暂无法查看转发名单'}
          onClick={() => setForwardOpen(true)}
        />
        <QzoneUpvoteAction
          value={view.upvote}
          onClick={capabilities.canUpvote && view.actionable ? () => void upvote() : undefined}
          pending={pending === 'upvote'}
          disabled={pending !== null}
          onSpace={onSpace}
        />
        <span className="weq-qzn-views" title="浏览量（非去重访客数）">
          <Eye size={16} />
          <span className="weq-qzn-action-label">浏览量</span>{' '}
          <span className="weq-number">{countText(view.viewCount)}</span>
        </span>
      </QzoneActionsRow>
      {error ? (
        <p className="weq-qzn-error" role="alert">
          {error}
        </p>
      ) : null}
      {expanded && view.actionable ? (
        <PublicFeedDetail
          initialData={initialDetail}
          focusComment={focusComment}
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
          <QzonePersonHeader
            uin={canOpenSpace ? view.author.uin : null}
            nickname={authorLabel}
            url={view.author.portrait}
            size={36}
            onSpace={onSpace}
            time={
              <time>
                <NumericText>{timeText(view.time)}</NumericText>
              </time>
            }
          />
          <p className="weq-qzn-content">
            <QzoneInlineText content={view.text} />
          </p>
          <QzoneMediaGrid images={grid.images} videos={grid.videos} />
        </QzoneForwardDialog>
      ) : null}
    </article>
  );
}

function PublicCommentIdentity({
  author,
  size,
}: {
  author: PublicCommentView['author'];
  size: number;
}) {
  const name = author.nick || author.uin || '匿名用户';
  return author.uin && /^[1-9]\d{4,19}$/.test(author.uin) ? (
    <QzonePersonIdentity
      uin={author.uin}
      nickname={name}
      url={author.portrait}
      size={size}
      className="weq-qzn-public-name"
    />
  ) : (
    <span className="weq-qzn-identity-link">
      <QqAvatar uin={null} url={author.portrait} size={size} />
      <span className="weq-qzn-public-name weq-qzn-name">
        <QzoneInlineText content={name} />
      </span>
    </span>
  );
}

function PublicFeedDetail({
  selfUin,
  view,
  identity,
  canComment,
  onCommentCount,
  onWrote,
  initialData,
  focusComment,
}: {
  selfUin: string;
  view: PublicFeedView;
  identity: SelfIdentity | null;
  canComment: boolean;
  onCommentCount: (count: number) => void;
  /** 写成功回调：主进程这时才从回执里学到公共域 uid，需要重读身份。 */
  onWrote: () => void;
  initialData?: PublicJson;
  focusComment?: PublicCommentFocus;
}): ReactElement {
  const root = useRef<HTMLElement>(null);
  const loadedCursors = useRef(new Set<string>());
  const pageRequest = useRef<AbortController | null>(null);
  const { active } = useContext(QzonePageContext);
  const { run, cancel } = useQzoneRequests('qzonePublic');
  const [comments, setComments] = useState<PublicCommentView[] | null>(null);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
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
  useEffect(
    () => () => {
      pageRequest.current?.abort();
      pageRequest.current = null;
    },
    [active, view.feed],
  );

  // 首批评论来自详情；之后的续页用 attach_info。
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    loadedCursors.current.clear();
    setError('');
    setPageError('');
    setLoading(true);
    if (initialData && retry === 0) {
      const page = projectPublicDetail(initialData);
      setComments(page.comments);
      setCursor(page.cursor);
      setHasMore(page.hasMore && Boolean(page.cursor));
      setLoading(false);
      return;
    }
    void run((requestId) =>
      client.account.qzonePublic.detail.query({ selfUin, requestId, feed: view.feed }),
    )
      .then((data) => {
        if (!live) return;
        const page = projectPublicDetail(data);
        setComments(page.comments);
        setCursor(page.cursor);
        setHasMore(page.hasMore && Boolean(page.cursor));
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
  }, [active, selfUin, view.feed, retry, run, cancel, initialData]);

  const loadMore = useCallback(() => {
    if (!active || !cursor || loading || pageRequest.current) return;
    const request = new AbortController();
    pageRequest.current = request;
    setLoading(true);
    setPageError('');
    void run(
      (requestId) =>
        client.account.qzonePublic.comments.query({
          selfUin,
          requestId,
          feed: view.feed,
          cursor,
        }),
      false,
      request.signal,
    )
      .then((data) => {
        if (request.signal.aborted) return;
        const page = projectPublicCommentsPage(data);
        loadedCursors.current.add(cursor);
        setComments((current) => mergePublicComments(current ?? [], page.comments));
        setCursor(page.cursor);
        setHasMore(
          page.hasMore &&
            page.comments.length > 0 &&
            Boolean(page.cursor) &&
            !loadedCursors.current.has(page.cursor),
        );
      })
      .catch((reason: unknown) => {
        if (!request.signal.aborted) setPageError(errorText(reason));
      })
      .finally(() => {
        if (pageRequest.current !== request) return;
        pageRequest.current = null;
        setLoading(false);
      });
  }, [active, cursor, loading, run, selfUin, view.feed]);
  const focusParent = focusComment?.parentCommentId || focusComment?.commentId;
  const focusFound = comments?.some((comment) => comment.id === focusParent) ?? false;
  useEffect(() => {
    if (
      !active ||
      !focusParent ||
      !comments ||
      focusFound ||
      loading ||
      error ||
      pageError ||
      !hasMore
    )
      return;
    loadMore();
  }, [active, focusParent, comments, focusFound, loading, error, pageError, hasMore, loadMore]);
  useSearchTargetFocus(
    root,
    'data-public-comment-key',
    focusComment
      ? JSON.stringify([focusComment.parentCommentId ?? '', focusComment.commentId])
      : undefined,
    comments !== null,
    comments?.reduce((sum, comment) => sum + 1 + comment.replies.length, 0),
  );

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
  const composerElement = canComment ? (
    <div className="weq-qzn-public-composer">
      {replyTarget ? (
        <p className="weq-qzn-status">
          回复{' '}
          <span className="weq-qzn-name">
            <QzoneInlineText
              content={
                replyTarget.reply?.author.nick || replyTarget.comment.author.nick || '这条评论'
              }
            />
          </span>
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
  ) : null;

  return (
    <section
      ref={root}
      className="weq-qzn-interaction weq-qzn-public-detail"
      aria-label="空友动态评论"
    >
      <p className="weq-qzn-status">该内容来自「空友爱看」</p>
      {focusParent && comments && !focusFound && !loading && !hasMore ? (
        <p role="alert">未找到搜索中的评论，可能已移除；原搜索结果仍保留</p>
      ) : null}
      {comments === null && loading ? <LoadingStatus text="正在加载评论…" /> : null}
      {error ? (
        <p className="weq-qzn-error" role="alert">
          {error}{' '}
          <button
            type="button"
            className="weq-retry-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={14} aria-hidden />
            重试
          </button>
        </p>
      ) : null}
      {pageError ? (
        <>
          <p className="weq-qzn-error" role="alert">
            {pageError}
          </p>
          <QzonePageButton label="重试" retry loading={loading} onClick={loadMore} />
        </>
      ) : null}
      {comments !== null ? (
        <>
          <p className="weq-qzn-status">
            {view.commentCount === null ? (
              ''
            ) : (
              <NumericText>{`共 ${countText(view.commentCount)} 条评论`}</NumericText>
            )}
          </p>
          {comments.map((comment) => (
            <div
              key={comment.id || comment.time}
              data-public-comment-key={JSON.stringify(['', comment.id])}
              className="weq-qzn-public-comment"
            >
              <div className="weq-qzn-comment">
                <div>
                  <PublicCommentIdentity author={comment.author} size={26} />
                  <p>
                    <QzoneInlineText content={comment.text} />
                  </p>
                  <QzoneMediaGrid images={publicGridMedia(comment.media).images} />
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
                      <button
                        data-danger="outline"
                        type="button"
                        onClick={() => void remove(comment)}
                      >
                        删除
                      </button>
                    ) : null}
                    <CommentLike selfUin={selfUin} feed={view.feed} comment={comment} />
                  </div>
                  {replyTarget?.comment.id === comment.id && !replyTarget.reply
                    ? composerElement
                    : null}
                </div>
              </div>
              {comment.replyCount > 0 ||
              comment.replies.length ||
              focusComment?.parentCommentId === comment.id ? (
                <div className="weq-qzn-public-replies">
                  {comment.replies.map((reply) => (
                    <div
                      key={reply.id || `${comment.id}:${reply.time}`}
                      data-public-comment-key={JSON.stringify([comment.id, reply.id])}
                      className="weq-qzn-comment is-reply"
                    >
                      <div>
                        <PublicCommentIdentity author={reply.author} size={22} />
                        <p>
                          <QzoneInlineText content={reply.text} />
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
                            <button
                              data-danger="outline"
                              type="button"
                              onClick={() => void remove(comment, reply)}
                            >
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
                        {replyTarget?.comment.id === comment.id &&
                        replyTarget.reply?.id === reply.id
                          ? composerElement
                          : null}
                      </div>
                    </div>
                  ))}
                  <ReplyMore
                    focusReplyId={
                      focusComment?.parentCommentId === comment.id
                        ? focusComment.commentId
                        : undefined
                    }
                    selfUin={selfUin}
                    feed={view.feed}
                    comment={comment}
                    onLoaded={(replies) =>
                      setComments(
                        (current) =>
                          current?.map((entry) =>
                            entry.id === comment.id
                              ? { ...entry, replies: mergePublicComments(entry.replies, replies) }
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
            !error && !pageError ? (
              <QzoneAutoPage key={cursor} loading={loading} onNext={loadMore} />
            ) : null
          ) : comments.length === 0 ? (
            <EmptyState variant="inline" icon={<MessageCircle />} title="还没有评论" />
          ) : null}
        </>
      ) : null}
      {!replyTarget ? composerElement : null}
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
      {count > 0 ? <span className="weq-number weq-number-inherit">{count}</span> : ''}
    </button>
  );
}

/** 首屏之外的回复：评论自带 reply_attach_info，续页用上一页的游标。 */
function ReplyMore({
  selfUin,
  feed,
  comment,
  onLoaded,
  focusReplyId,
}: {
  selfUin: string;
  feed: PublicJson;
  comment: PublicCommentView;
  onLoaded: (replies: PublicCommentView[]) => void;
  focusReplyId?: string;
}) {
  const [cursor, setCursor] = useState(comment.replyCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const remaining = comment.replyCount - comment.replies.length;
  const { active } = useContext(QzonePageContext);
  const { run } = useQzoneRequests('qzonePublic');
  const loadedCursors = useRef(new Set<string>());
  const pageRequest = useRef<AbortController | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const found = comment.replies.some((reply) => reply.id === focusReplyId);
  useEffect(() => {
    if (!active || !focusReplyId || found || busy || done || error) return;
    void loadRef.current();
  }, [active, focusReplyId, found, busy, done, error, cursor]);
  useEffect(() => {
    if (!active) setBusy(false);
    return () => {
      pageRequest.current?.abort();
      pageRequest.current = null;
    };
  }, [active]);
  async function load(): Promise<void> {
    if (!active || pageRequest.current) return;
    const request = new AbortController();
    pageRequest.current = request;
    setBusy(true);
    setError('');
    try {
      const data = await run(
        (requestId) =>
          client.account.qzonePublic.replies.query({
            selfUin,
            feed,
            comment: comment.raw,
            cursor,
            requestId,
          }),
        false,
        request.signal,
      );
      if (request.signal.aborted) return;
      const page = projectPublicRepliesPage(data, comment.id);
      loadedCursors.current.add(cursor);
      onLoaded(page.replies);
      setCursor(page.cursor);
      if (!page.hasMore || page.replies.length === 0 || loadedCursors.current.has(page.cursor))
        setDone(true);
    } catch (reason) {
      if (!request.signal.aborted) setError(errorText(reason));
    } finally {
      if (pageRequest.current === request) {
        pageRequest.current = null;
        setBusy(false);
      }
    }
  }
  loadRef.current = load;
  if (remaining <= 0 && (!focusReplyId || found)) return null;
  return (
    <>
      {focusReplyId && done && !found ? (
        <p role="alert">未找到搜索中的回复，可能已移除；原搜索结果仍保留</p>
      ) : null}
      {error ? (
        <>
          <p className="weq-qzn-error" role="alert">
            {error}
          </p>
          <QzonePageButton label="重试" retry onClick={() => void load()} />
        </>
      ) : !done ? (
        <QzoneAutoPage key={cursor} loading={busy} onNext={() => void load()} />
      ) : null}
    </>
  );
}
