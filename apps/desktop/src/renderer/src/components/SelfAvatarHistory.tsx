import { eventTimeFormatter } from '@weq/time';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowUpWideNarrow, ImagePlus, RotateCcw, X } from 'lucide-react';
import type { HistoricalAvatar } from '@weq/protocol';
import { Modal } from './Dialog';
import { MediaPreview } from './MediaPreview';
import { SegmentedControl } from './SegmentedControl';
import { useQQWriteSession, type QQWriteBinding } from '../hooks/useQQWriteSession';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { trpc } from '../trpc/client';
import { avatarFetchUrl } from '../lib/resourceUrl';
import { extrasPageWarning, mergeExtrasPages, nextExtrasCursor } from '../lib/profileExtrasPages';
import { sortHistoricalAvatars } from '../lib/avatarHistory';
import { pickAccountFile } from '../lib/accountFilePicker';
import { refreshUserAvatar } from '../hooks/useAvatarUrl';
import '../styles/avatar-history.css';

const formatter = eventTimeFormatter;
export const avatarHistoryTime = (value: number | null) =>
  value === null ? '时间未记录' : formatter.format(value * 1000);

export function SelfAvatarHistory({
  uin,
  children,
  className,
}: {
  uin: string;
  children?: ReactNode;
  className?: string;
}) {
  const session = useQQWriteSession('self-avatar-history');
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const identity = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  return (
    <>
      <button
        ref={anchor}
        className={className}
        type="button"
        title="历史头像"
        aria-label="历史头像"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      {open && session.binding?.expectedAccountUin === uin ? (
        <AvatarHistoryDialog
          key={identity}
          binding={session.binding}
          online={session.available}
          anchor={anchor.current}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
export function AvatarHistoryDialog({
  binding,
  online,
  onClose,
  anchor,
}: {
  binding: QQWriteBinding;
  online: boolean;
  onClose: () => void;
  anchor?: HTMLElement | null;
}) {
  const titleId = useId();
  const activity = useQQReadActivity(online);
  const [field, setField] = useState<'firstUsedAt' | 'lastUsedAt'>('lastUsedAt');
  const [ascending, setAscending] = useState(false);
  const [preview, setPreview] = useState<{ items: HistoricalAvatar[]; id: string } | null>(null);
  const query = trpc.account.profileExtras.avatarHistory.useInfiniteQuery(binding, {
    enabled: activity.enabled,
    retry: false,
    staleTime: 5 * 60_000,
    cacheTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    getNextPageParam: nextExtrasCursor,
  });
  const pages = query.data?.pages ?? [];
  const warning = extrasPageWarning(pages);
  const items = useMemo(
    () => sortHistoricalAvatars(mergeExtrasPages(query.data?.pages ?? []), field, ascending),
    [query.data, field, ascending],
  );
  const complete = pages.length > 0 && !query.hasNextPage && !warning && !query.error;
  const fetchNextPage = query.fetchNextPage;
  useEffect(() => {
    if (!activity.enabled || query.isFetching || query.error || warning || !query.hasNextPage)
      return;
    const timer = setTimeout(() => {
      void fetchNextPage().catch(() => {});
    }, 1100);
    return () => clearTimeout(timer);
  }, [
    activity.enabled,
    query.isFetching,
    query.error,
    query.hasNextPage,
    query.dataUpdatedAt,
    warning,
    fetchNextPage,
  ]);
  const retry = () => {
    if (warning) void query.refetch({ refetchPage: (_p, index, all) => index === all.length - 1 });
    else if (pages.length) void query.fetchNextPage();
    else void query.refetch();
  };
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      width={760}
      className="weq-avatar-history-dialog"
      presentation={anchor ? 'popover' : 'modal'}
      anchor={anchor}
      anchorPlacement="side"
    >
      <header className="weq-avatar-history-header">
        <h2 id={titleId}>历史头像</h2>
        <button type="button" title="关闭" aria-label="关闭历史头像" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="weq-avatar-history-toolbar">
        <SelfAvatarChange
          key={`${binding.expectedAccountUin}:${binding.expectedAccountConfigId}`}
        />
        <SegmentedControl
          label="头像排序时间"
          value={field}
          options={[
            { value: 'lastUsedAt', label: '最后使用时间' },
            { value: 'firstUsedAt', label: '最早使用时间' },
          ]}
          onChange={setField}
        />
        <button
          type="button"
          title={ascending ? '从旧到新，点击切换' : '从新到旧，点击切换'}
          aria-label={ascending ? '改为从新到旧' : '改为从旧到新'}
          onClick={() => setAscending((value) => !value)}
        >
          {ascending ? <ArrowUpWideNarrow size={18} /> : <ArrowDownWideNarrow size={18} />}
        </button>
      </div>
      <div className="weq-avatar-history-content" data-privacy-sensitive>
        <p className="weq-avatar-history-progress" role="status">
          {complete
            ? `共 ${items.length} 个头像`
            : items.length
              ? `已加载 ${items.length} 个${activity.enabled && !query.error && !warning ? '，继续读取中' : ''}`
              : query.isFetching
                ? '读取中…'
                : !online
                  ? '暂不可在线读取'
                  : query.error
                    ? '读取失败'
                    : '暂无历史头像'}
        </p>
        {query.error || warning ? (
          <div className="weq-avatar-history-error" role="status">
            <span>{warning || '读取失败，已加载头像保留。'}</span>
            <button
              className="weq-set-btn weq-set-btn-soft"
              type="button"
              disabled={!online || query.isFetching}
              onClick={retry}
            >
              <RotateCcw size={14} />
              重试
            </button>
          </div>
        ) : null}
        <div className="weq-avatar-history-grid">
          {items.map((item) => (
            <article key={item.id}>
              <button
                type="button"
                className="weq-avatar-history-image"
                aria-label={`查看头像，最早使用 ${avatarHistoryTime(item.firstUsedAt)}`}
                onClick={() => setPreview({ items, id: item.id })}
              >
                <HistoryThumbnail item={item} />
              </button>
              <dl>
                <dt>最早使用</dt>
                <dd>
                  <time>{avatarHistoryTime(item.firstUsedAt)}</time>
                </dd>
                <dt>最后使用</dt>
                <dd>
                  <time>{avatarHistoryTime(item.lastUsedAt)}</time>
                </dd>
              </dl>
            </article>
          ))}
        </div>
      </div>
      {preview ? (
        <MediaPreview
          label="历史头像预览"
          items={preview.items.map((item) => ({
            key: item.id,
            kind: 'image',
            src: avatarFetchUrl(item.url),
            title: `最早使用 ${avatarHistoryTime(item.firstUsedAt)}；最后使用 ${avatarHistoryTime(item.lastUsedAt)}`,
          }))}
          initialIndex={preview.items.findIndex((item) => item.id === preview.id)}
          onClose={() => setPreview(null)}
          renderActions={(item) => {
            const avatar = preview.items.find((avatar) => avatar.id === item.key)!;
            return (
              <span>
                最早使用 {avatarHistoryTime(avatar.firstUsedAt)} · 最后使用{' '}
                {avatarHistoryTime(avatar.lastUsedAt)}
              </span>
            );
          }}
        />
      ) : null}
    </Modal>
  );
}

/** 对话框自行绑定账号，名片无需挂载整页资料编辑器。 */
export function SelfAvatarChange() {
  const session = useQQWriteSession('self-avatar-change');
  const utils = trpc.useUtils();
  const avatar = trpc.account.qqWrite.selfAvatar.useMutation();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const identity = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const currentIdentity = useRef<string | null>(identity);
  const running = useRef(false);
  currentIdentity.current = identity;
  useEffect(() => {
    currentIdentity.current = identity;
    setError('');
    return () => {
      currentIdentity.current = null;
    };
  }, [identity]);
  async function pickAvatar() {
    if (!session.available || session.busy || running.current) return;
    const capturedIdentity = identity;
    running.current = true;
    setPicking(true);
    setError('');
    try {
      const file = await pickAccountFile('image', session.binding ?? undefined);
      if (!file || currentIdentity.current !== capturedIdentity) return;
      await session.run(
        async (binding) => {
          const outcome = await avatar.mutateAsync({ ...binding, source: file.path });
          // 已提交的请求关闭对话框后仍可能完成，按原账号刷新缓存。
          refreshUserAvatar(binding.expectedAccountUin);
          void Promise.all([
            utils.account.getSelfProfile.invalidate(),
            utils.account.profileExtras.avatarHistory.invalidate(binding),
          ]).catch(() => {});
          return outcome;
        },
        () => utils.account.getSelfProfile.invalidate(),
        { backgroundRefresh: true },
      );
    } catch (cause) {
      if (currentIdentity.current === capturedIdentity)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      if (currentIdentity.current !== null) setPicking(false);
    }
  }
  return (
    <div className="weq-avatar-history-change">
      <button
        className="weq-set-btn"
        type="button"
        aria-label="更换头像"
        disabled={!session.available || session.busy || picking}
        aria-busy={picking || session.busy || undefined}
        onClick={() => void pickAvatar()}
      >
        <ImagePlus size={16} />
        更换头像
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
function HistoryThumbnail({ item }: { item: HistoricalAvatar }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span>图片暂不可用</span>
  ) : (
    <img
      src={avatarFetchUrl(item.thumbnailUrl)}
      alt="历史头像"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
