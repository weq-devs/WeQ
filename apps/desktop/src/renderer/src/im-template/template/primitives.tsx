// @ts-nocheck
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from './classNames';
import { DefaultAvatar } from './defaultAvatar';
import { cachedAvatarUrl } from '../../lib/avatarCache';
import { useDebouncedLoading } from '../../hooks/useDebouncedLoading';

export function Avatar({
  name,
  avatarUrl,
  seed,
}: {
  name: string;
  avatarUrl?: string | null;
  seed?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const resolved = cachedAvatarUrl(avatarUrl);

  useLayoutEffect(() => {
    setFailed(false);
    setLoaded(false);
    // 图片已缓存（或 data: 立即完成）时直接显示，避免 shimmer 闪现。
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [resolved]);

  const hasImage = Boolean(resolved) && !failed;
  const showShimmer = hasImage && !loaded;

  return (
    <span
      className={cn('avatar', hasImage ? 'has-image' : 'has-default', showShimmer && 'is-loading')}
    >
      {hasImage ? (
        <>
          {showShimmer ? <span className={cn('skel-block', 'avatar-shimmer')} aria-hidden /> : null}
          <img
            ref={imgRef}
            src={resolved}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </>
      ) : (
        <DefaultAvatar seed={seed || name} />
      )}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn('empty-state')}>
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

export function LoadingState({ text = '加载中...' }: { text?: string }) {
  return (
    <div className={cn('loading-state')}>
      <div className={cn('loading-spinner')} />
      <span>{text}</span>
    </div>
  );
}

/**
 * 会话/联系人列表的 skeleton 占位行：圆形头像 + 两行文字条，带 shimmer 动画。
 * 用于数据量较大、列表尚未就绪时替代空白/转圈。
 * 加载很快时不会闪现，超过 `delayMs` 才显示（防抖）。
 */
export function ListSkeleton({ rows = 8, delayMs = 100 }: { rows?: number; delayMs?: number }) {
  const visible = useDebouncedLoading(true, delayMs);
  if (!visible) return null;
  return (
    <div className={cn('list-skeleton')} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
        <div className={cn('list-skeleton-row')} key={i}>
          <span className={cn('skel-block', 'list-skeleton-avatar')} />
          <span className={cn('list-skeleton-main')}>
            <span className={cn('skel-block', 'list-skeleton-line')} />
            <span className={cn('skel-block', 'list-skeleton-line', 'list-skeleton-line-short')} />
          </span>
          <span className={cn('skel-block', 'list-skeleton-meta')} />
        </div>
      ))}
    </div>
  );
}

/**
 * 聊天消息加载骨架：既有对方消息占位，也有自己消息占位，消息形状大小不一
 * （长文本 / 短文本 / 图片方块 / 卡片），模拟真实会话布局。
 * 加载很快时不会闪现，超过 `delayMs` 才显示（防抖）。
 */
export function ChatMessagesSkeleton({ delayMs = 100 }: { delayMs?: number }) {
  const visible = useDebouncedLoading(true, delayMs);
  if (!visible) return null;
  const rows = [
    { key: 'a', mine: false, variant: 'text', lines: ['a1', 'a2', 'a3'] },
    { key: 'b', mine: false, variant: 'text', lines: ['b1'] },
    { key: 'c', mine: true, variant: 'text', lines: ['c1', 'c2'] },
    { key: 'd', mine: false, variant: 'image' },
    { key: 'e', mine: true, variant: 'text', lines: ['e1'] },
    { key: 'f', mine: false, variant: 'card' },
    { key: 'g', mine: true, variant: 'image' },
    { key: 'h', mine: false, variant: 'text', lines: ['h1', 'h2'] },
    { key: 'i', mine: true, variant: 'text', lines: ['i1', 'i2', 'i3'] },
    { key: 'j', mine: true, variant: 'card' },
  ];
  return (
    <div className={cn('chat-skeleton')} aria-hidden>
      <span className={cn('skel-block', 'chat-skeleton-time')} />
      {rows.map((row) => (
        <div className={cn('chat-skeleton-line', row.mine ? 'mine' : 'theirs')} key={row.key}>
          {!row.mine ? <span className={cn('skel-block', 'chat-skeleton-avatar')} /> : null}
          <div className={cn('chat-skeleton-bubble', `chat-skeleton-bubble-${row.variant}`)}>
            {row.variant === 'text' ? (
              (row.lines ?? []).map((lineKey, l) => (
                <span
                  className={cn(
                    'skel-block',
                    'chat-skeleton-bar',
                    l === 0 && 'is-first',
                    l === (row.lines?.length ?? 1) - 1 && 'is-last',
                  )}
                  key={lineKey}
                />
              ))
            ) : row.variant === 'image' ? (
              <span className={cn('skel-block', 'chat-skeleton-image')} />
            ) : (
              <>
                <span className={cn('skel-block', 'chat-skeleton-card-thumb')} />
                <span className={cn('skel-block', 'chat-skeleton-bar')} />
                <span
                  className={cn('skel-block', 'chat-skeleton-bar', 'chat-skeleton-bar-short')}
                />
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 群资料面板的 skeleton 占位：标题条 + 若干「标签/值」资料行，模拟群资料布局。
 * 加载很快时不会闪现，超过 `delayMs` 才显示（防抖）。
 */
export function GroupInfoSkeleton({ delayMs = 100 }: { delayMs?: number }) {
  const visible = useDebouncedLoading(true, delayMs);
  if (!visible) return null;
  return (
    <div className={cn('group-info-skeleton')} aria-hidden>
      <span className={cn('skel-block', 'group-info-skeleton-heading')} />
      <div className={cn('group-info-skeleton-rows')}>
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className={cn('group-info-skeleton-row')} key={i}>
            <span className={cn('skel-block', 'group-info-skeleton-label')} />
            <span className={cn('skel-block', 'group-info-skeleton-value')} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 群成员列表的 skeleton 占位：小圆形头像 + 名字条，模拟成员行布局（同 ListSkeleton）。
 * 加载很快时不会闪现，超过 `delayMs` 才显示（防抖）。
 */
export function GroupMembersSkeleton({
  rows = 8,
  delayMs = 100,
}: {
  rows?: number;
  delayMs?: number;
}) {
  const visible = useDebouncedLoading(true, delayMs);
  if (!visible) return null;
  return (
    <div className={cn('group-members-skeleton')} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
        <div className={cn('group-members-skeleton-row')} key={i}>
          <span className={cn('skel-block', 'group-members-skeleton-avatar')} />
          <span className={cn('skel-block', 'group-members-skeleton-name')} />
        </div>
      ))}
    </div>
  );
}

export function ToggleRow({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn('details-toggle-row')}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className={cn(`switch-control ${checked ? 'on' : ''}`)}>
        <span />
      </span>
    </button>
  );
}
