import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Heart, Loader2, RefreshCw, MoreHorizontal, UsersRound } from 'lucide-react';
import type { QzoneUpvotePreview } from '@weq/protocol';
import { client } from '../trpc/client';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { QzoneLikesPopover } from './QzoneLikesPopover';
import { QzonePersonIdentity } from './QzoneProfileAvatar';
import { QqAvatar } from './QqAvatar';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { useQQAction } from './qq-actions/shared.shared';
import { useToast } from './Toast.shared';
import { qzoneMediaSource } from '../lib/qzone';
import { ShimmerImage } from './ShimmerImage';
import { HoverPopover } from './HoverPopover';
import '../styles/qzone-archive.css';
import {
  qzoneCardTarget,
  QzoneCardNavigationContext,
  QzonePublicNavigationContext,
} from '../lib/qzoneNavigation';

type ArchiveView = inferRouterOutputs<AppRouter>['account']['qzone']['archiveState'];

function hasUpvotePreview(value: QzoneUpvotePreview | null): boolean {
  return value?.count != null || Boolean(value?.users.length);
}

export function QzoneUpvoteAction({
  value,
  onClick,
  pending = false,
  disabled = false,
  loading = false,
  error = '',
  onRetry,
  onSpace,
}: {
  value: QzoneUpvotePreview | null;
  onClick?: () => void;
  pending?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSpace?: (uin: string, nickname?: string) => void;
}) {
  if (!onClick && !hasUpvotePreview(value)) return null;
  const label = onClick ? (value?.upvoted ? '取消推' : '推') : '查看推过的人';
  return (
    <QzoneLikesPopover
      label="推的人"
      clickOnly={!onClick}
      trigger={(open) => (
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={onClick ? (value?.upvoted ?? false) : undefined}
          aria-expanded={onClick ? undefined : open}
          aria-busy={pending || undefined}
          disabled={Boolean(onClick) && (pending || disabled)}
          onClick={onClick}
        >
          {pending ? (
            <Loader2 size={16} className="weq-spin" />
          ) : onClick ? (
            <Heart size={16} fill={value?.upvoted ? 'currentColor' : 'none'} />
          ) : (
            <UsersRound size={16} />
          )}
          {onClick ? '推' : label} <span className="weq-number">{value?.count ?? '?'}</span>
        </button>
      )}
    >
      <div className="weq-qzn-interaction">
        {loading ? <Loader2 size={14} className="weq-spin" aria-label="正在读取推预览" /> : null}
        <div className="weq-qzn-like-users">
          {value?.users.map((user, index) => {
            const name = user.nickname || user.uin || '空间用户';
            return (
              <span key={user.uid || user.uin || `preview-${index}`} title={name}>
                {user.uin ? (
                  <QzonePersonIdentity
                    uin={user.uin}
                    nickname={name}
                    url={user.portrait}
                    size={20}
                    onSpace={onSpace}
                  >
                    <span className="weq-qzn-name">{name}</span>
                  </QzonePersonIdentity>
                ) : (
                  <span className="weq-qzn-identity-link">
                    <QqAvatar uin={null} url={user.portrait} size={20} />
                    <span className="weq-qzn-name">{name}</span>
                  </span>
                )}
              </span>
            );
          })}
        </div>
        <p className="weq-qzn-status">
          {value?.count === 0 && !value.users.length
            ? '还没有人推过'
            : value?.users.length
              ? `已显示 ${value.users.length} 人${value.count === null ? '' : `，共 ${value.count} 人推过`}`
              : value?.count != null
                ? `共 ${value.count} 人推过，暂无用户预览`
                : loading
                  ? '正在读取推预览'
                  : '暂无可读取的推数据'}
        </p>
        {error ? (
          <p className="weq-qzn-error" role="status">
            {error}
          </p>
        ) : null}
        {onRetry && !loading ? (
          <button type="button" title="刷新推预览" aria-label="刷新推预览" onClick={onRetry}>
            <RefreshCw size={14} />
          </button>
        ) : null}
      </div>
    </QzoneLikesPopover>
  );
}

export type QzonePostArchiveControls = { tag: ReactNode; menu: ReactNode; upvote: ReactNode };

/** 作者区与互动栏共用原生详情缓存；只读取可见动态，不阻塞赞和正文。 */
export function QzonePostArchive({
  selfUin,
  hostUin,
  tid,
  time,
  enabled,
  refresh,
  onSpace,
  render,
}: {
  selfUin: string;
  hostUin: string;
  tid: string;
  time: number;
  enabled: boolean;
  refresh: number;
  onSpace?: (uin: string, nickname?: string) => void;
  render: (controls: QzonePostArchiveControls) => ReactNode;
}) {
  const requests = useQzoneRequests();
  const [value, setValue] = useState<QzoneUpvotePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [archive, setArchive] = useState<ArchiveView | null>(null);
  const write = useQQAction(`qzone-archive:${hostUin}:${tid}`, 'failure-only');
  const writeScope = `${selfUin}:${hostUin}:${tid}:${time}:${write.binding?.expectedAccountConfigId}`;
  const latestWriteScope = useRef(writeScope);
  latestWriteScope.current = writeScope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const toast = useToast((state) => state.push);
  const navigate = useContext(QzoneCardNavigationContext);
  const openPublic = useContext(QzonePublicNavigationContext);
  const completed = useRef<string | null>(null);
  const revision = `${selfUin}:${hostUin}:${tid}:${time}:${refresh}:${retry}`;
  useEffect(() => {
    if (!enabled || time <= 0 || completed.current === revision) return;
    let active = true;
    setLoading(true);
    setError('');
    void requests
      .run(
        (requestId) =>
          client.account.qzone.archiveState.query({
            selfUin,
            hostUin,
            tid,
            time,
            requestId,
            refresh: completed.current !== null || retry > 0,
          }),
        true,
      )
      .then((state) => {
        if (!active) return;
        setArchive(state);
        if (!state.capabilitiesObserved) setError('空友爱看账号能力暂未读取成功，请重试。');
        const result = state.upvote;
        completed.current = revision;
        setValue(result);
        const missing =
          result?.users.filter((user) => user.uin && !user.nickname).map((user) => user.uin) ?? [];
        if (missing.length && result) {
          void requests
            .run(
              (requestId) =>
                client.account.qzone.people.query({
                  selfUin,
                  requestId,
                  uins: [...new Set(missing)].slice(0, 200),
                }),
              true,
            )
            .then((names) => {
              if (active)
                setValue((current) =>
                  current === result
                    ? {
                        ...result,
                        users: result.users.map((user) => ({
                          ...user,
                          nickname: user.nickname || names[user.uin] || '',
                        })),
                      }
                    : current,
                );
            })
            .catch(() => {});
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        completed.current = revision;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      requests.cancel();
    };
  }, [enabled, selfUin, hostUin, tid, time, revision, retry, requests]);
  const perform = async (action: 'contribute' | 'uncontribute' | 'unarchive') => {
    await write.perform(
      async () => {
        const result = await client.account.qzone.setArchiveState.mutate({
          selfUin,
          expectedAccountConfigId: write.binding!.expectedAccountConfigId,
          hostUin,
          tid,
          time,
          action,
          requestId: crypto.randomUUID(),
        });
        if (!mounted.current || latestWriteScope.current !== writeScope)
          return { state: 'unconfirmed' };
        if (result.state) {
          setArchive(result.state);
          setValue(result.state.upvote);
        }
        if (!result.confirmed)
          toast({ title: '操作已提交，暂未确认结果，请稍后刷新', tone: 'warning' });
        return { state: result.confirmed ? 'confirmed' : 'unconfirmed' };
      },
      undefined,
      action === 'contribute'
        ? '将这条说说投稿至空友爱看？'
        : action === 'unarchive'
          ? '取消这条说说的空友爱看收录？'
          : '取消这条说说的投稿？',
      { refreshCaches: false },
    );
  };
  const tag = archive?.tag;
  const tagIcon = tag?.iconUrl ? qzoneMediaSource(tag.iconUrl) : null;
  const target = tag ? qzoneCardTarget(tag.targetUrl) : null;
  const publicTarget = tag?.targetUrl.startsWith('mqzone://arouse/publicrecommend/feeds?') === true;
  const openTag = target && navigate ? () => navigate(target) : publicTarget ? openPublic : null;
  const canViewUpvotes = archive?.showUpvote && hasUpvotePreview(value);
  const canManage =
    selfUin === hostUin &&
    (archive?.canContribute || archive?.canUncontribute || archive?.canUnarchive);
  const showRetry = error && !canViewUpvotes;
  const retryRead = () => setRetry((current) => current + 1);
  return render({
    tag: tag ? (
      openTag ? (
        <button type="button" className="weq-qzn-archive-tag" title={tag.text} onClick={openTag}>
          {tagIcon ? <ShimmerImage src={tagIcon} alt="" width={16} height={16} /> : null}
          {tag.text}
        </button>
      ) : (
        <span className="weq-qzn-archive-tag">
          {tagIcon ? <ShimmerImage src={tagIcon} alt="" width={16} height={16} /> : null}
          {tag.text}
        </span>
      )
    ) : null,
    menu:
      canManage || showRetry ? (
        <>
          {canManage ? (
            <HoverPopover
              label="空友爱看管理操作"
              clickOnly
              trigger={(open) => (
                <button
                  type="button"
                  className="weq-qzn-archive-menu-button"
                  title="空友爱看管理"
                  aria-label="空友爱看管理"
                  aria-expanded={open}
                  aria-busy={write.pending}
                >
                  {write.pending ? (
                    <Loader2 size={16} className="weq-spin" />
                  ) : (
                    <MoreHorizontal size={16} />
                  )}
                </button>
              )}
            >
              {(_open, dismiss) => (
                <div className="weq-qzn-archive-operations">
                  {(
                    [
                      ['contribute', archive.canContribute, '投稿至空友爱看'],
                      ['uncontribute', archive.canUncontribute, '取消投稿'],
                      ['unarchive', archive.canUnarchive, '取消收录'],
                    ] as const
                  ).map(([action, allowed, label]) =>
                    allowed ? (
                      <button
                        key={action}
                        type="button"
                        disabled={write.disabled}
                        onClick={() => {
                          dismiss();
                          void perform(action);
                        }}
                      >
                        {label}
                      </button>
                    ) : null,
                  )}
                </div>
              )}
            </HoverPopover>
          ) : null}
          {showRetry ? (
            <button
              type="button"
              className="weq-qzn-archive-menu-button"
              title={error}
              aria-label="重试空友状态"
              onClick={retryRead}
            >
              <RefreshCw size={14} />
            </button>
          ) : null}
        </>
      ) : null,
    upvote: canViewUpvotes ? (
      <QzoneUpvoteAction
        value={value}
        loading={enabled && time > 0 && loading}
        error={error}
        onSpace={onSpace}
        onRetry={enabled && time > 0 && error ? retryRead : undefined}
      />
    ) : null,
  });
}
