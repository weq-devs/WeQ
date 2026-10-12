/**
 * 贴表情（表情回应）的「谁贴了这个表情」面板。
 *
 * 悬停在消息气泡下方的一个表情 chip 上时，在鼠标附近弹出：头部是这枚表情 + 回应人数，
 * 正文是**回应人名单**（头像 + 昵称 + QQ 号），滚到底自动续传下一页（0x9083_1 的 cookie）。
 * 自己那一行高亮（强调色底 + 左侧色条 + 「我」标）。
 *
 * 数据来源是**在线的 QQ**：本地 40062 列只有「被贴了几次」，没有名单。所以离线 / 风控
 * 失败时这里显示错误原因（而不是空列表），失败带重试。
 *
 * 定位：跟着**鼠标**（`anchor`），钳在视口内，下方放不下就翻到鼠标上方。渲染在 body 的
 * portal 里 —— 消息列表有自己的滚动容器 / 变换，`position: fixed` 留在里面会跟错坐标系。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RotateCw, Users } from 'lucide-react';
import { trpc } from '../trpc/client';
import { cn } from '../lib/utils';
import { QqAvatar } from './QqAvatar';

/** 每页条数（IPC 侧上限 200）。 */
const PAGE_SIZE = 30;

/** 鼠标到面板的偏移；下方空间不够时翻到上方用同样的间距。 */
const CURSOR_OFFSET = 14;

/** 视口边缘留白。 */
const VIEWPORT_MARGIN = 8;

export function ReactionLikersPanel({
  anchor,
  groupId,
  sequence,
  emojiId,
  icon,
  emojiLabel,
  setNum,
  onPointerEnter,
  onPointerLeave,
  onClose,
}: {
  /** 鼠标位置（client 坐标）。 */
  anchor: { x: number; y: number };
  /** 群号。 */
  groupId: string;
  /** 被回应消息的 msgSeq。 */
  sequence: number;
  /** 表情 id。 */
  emojiId: string;
  /** 头部的表情本体（由 SetEmojiReactions 复用同一套 chip 渲染）。 */
  icon: ReactNode;
  /** 表情的无障碍名称 / title。 */
  emojiLabel: string;
  /** 本地记录的贴表情次数（服务端名单拉回来之前的头部兜底数字）。 */
  setNum: number;
  /** 指针移进面板：宿主据此取消「离开就关」的定时器。 */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const selfUin = selfProfile.data?.uin ? String(selfProfile.data.uin) : '';

  const query = trpc.account.messageReactionUsers.useInfiniteQuery(
    { groupId, sequence, emojiId, count: PAGE_SIZE },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // 同一枚表情反复悬停不必每次重拉；换表情 / 换消息是新 key，自然重查。
      staleTime: 30_000,
      enabled: Boolean(groupId) && sequence > 0 && Boolean(emojiId),
    },
  );

  // 分页拍平 + 按 uin 去重（服务端分页理论上不重叠，这里只是兜底）。
  const users = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ uin: string; nick: string; avatarUrl: string }> = [];
    for (const page of query.data?.pages ?? []) {
      for (const user of page.items) {
        if (seen.has(user.uin)) continue;
        seen.add(user.uin);
        out.push(user);
      }
    }
    return out;
  }, [query.data]);

  const hasMore = Boolean(query.hasNextPage);
  const total = users.length > 0 ? (hasMore ? `${users.length}+` : String(users.length)) : null;

  // 跟着鼠标定位，并钳进视口；下方不够就翻到鼠标上方。
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const below = anchor.y + CURSOR_OFFSET;
    const fitsBelow = below + rect.height + VIEWPORT_MARGIN <= window.innerHeight;
    const top = fitsBelow
      ? below
      : Math.max(VIEWPORT_MARGIN, anchor.y - rect.height - CURSOR_OFFSET);
    const left = Math.min(
      Math.max(anchor.x, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN),
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [anchor.x, anchor.y, users.length, query.isLoading]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /** 滚到底续传下一页（cookie 分页）。 */
  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    if (!hasMore || query.isFetchingNextPage) return;
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 32) {
      void query.fetchNextPage();
    }
  }

  const error = query.isError ? normalizeError(query.error) : null;

  return createPortal(
    <div
      ref={panelRef}
      className={cn('reaction-likers')}
      role="dialog"
      aria-label={`${emojiLabel} 的回应人`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className={cn('reaction-likers-head')}>
        <span className={cn('reaction-likers-emoji')} title={emojiLabel}>
          {icon}
        </span>
        <span className={cn('reaction-likers-title')}>
          {error ? '回应人' : total ? `${total} 人贴了` : `${setNum} 人贴了`}
        </span>
        <Users size={13} strokeWidth={2} className={cn('reaction-likers-head-icon')} aria-hidden />
      </div>

      {error ? (
        <div className={cn('reaction-likers-state', 'is-error')}>
          <span className={cn('reaction-likers-state-text')}>{error}</span>
          <button
            type="button"
            className={cn('reaction-likers-retry')}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RotateCw size={12} strokeWidth={2.2} />
            {query.isFetching ? '重试中…' : '重试'}
          </button>
        </div>
      ) : query.isLoading ? (
        <div className={cn('reaction-likers-body')}>
          <SkeletonRows />
        </div>
      ) : users.length === 0 ? (
        <div className={cn('reaction-likers-state')}>
          <span className={cn('reaction-likers-state-text')}>还没有人贴这个表情</span>
        </div>
      ) : (
        <>
          <div className={cn('reaction-likers-body')} onScroll={onScroll}>
            {users.map((user) => {
              const isSelf = selfUin !== '' && user.uin === selfUin;
              // 服务端 / 本地都没给昵称时退化成 QQ 号，至少还能认人。
              const name = user.nick || `QQ ${user.uin}`;
              return (
                <div
                  key={user.uin}
                  className={cn('reaction-likers-row', isSelf && 'is-self')}
                  title={user.nick ? `${user.nick}（${user.uin}）` : user.uin}
                >
                  <QqAvatar
                    uin={user.uin}
                    url={user.avatarUrl || null}
                    size={30}
                    className={cn('reaction-likers-avatar')}
                  />
                  <span className={cn('reaction-likers-meta')}>
                    <span className={cn('reaction-likers-name')}>{name}</span>
                    {user.nick ? (
                      <span className={cn('reaction-likers-uin')}>{user.uin}</span>
                    ) : null}
                  </span>
                  {isSelf ? <span className={cn('reaction-likers-tag')}>我</span> : null}
                </div>
              );
            })}
            {query.isFetchingNextPage ? <SkeletonRows rows={2} /> : null}
          </div>
          <div className={cn('reaction-likers-foot')}>
            {hasMore ? '滚动查看更多' : `共 ${users.length} 人`}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

/** 骨架行的固定 id 序列（行数是常量，只是不想用 index 当 key）。 */
const SKELETON_KEYS = ['s1', 's2', 's3', 's4'] as const;

/** 加载占位：头像 + 名字条，避免面板高度跳动。 */
function SkeletonRows({ rows = SKELETON_KEYS.length }: { rows?: number }) {
  return (
    <>
      {SKELETON_KEYS.slice(0, rows).map((id) => (
        <div key={id} className={cn('reaction-likers-row', 'is-skeleton')} aria-hidden>
          <span className={cn('reaction-likers-skel', 'is-avatar')} />
          <span className={cn('reaction-likers-skel', 'is-name')} />
        </div>
      ))}
    </>
  );
}

/** tRPC 的错误形状不稳定，统一抠出一句能读的话。 */
function normalizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/需要先登录|完全离线模式/.test(raw)) {
    return '需要该账号的 QQ 在线才能看到回应人名单。';
  }
  return raw || '加载回应人失败。';
}
