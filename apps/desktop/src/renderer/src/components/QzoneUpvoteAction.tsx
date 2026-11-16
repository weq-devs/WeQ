import { useContext, useEffect, useRef, useState } from 'react';
import { Heart, Loader2, RefreshCw, MoreHorizontal } from 'lucide-react';
import type { QzoneUpvotePreview } from '@weq/protocol';
import { client } from '../trpc/client';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { QzoneLikesPopover } from './QzoneLikesPopover';
import { QzonePersonIdentity } from './QzoneProfileAvatar';
import { QqAvatar } from './QqAvatar';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { useQQAction } from './qq-actions/shared';
import { useToast } from './Toast';
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

export function QzoneUpvoteAction({
  value,
  onClick,
  pending = false,
  loading = false,
  error = '',
  onRetry,
  onSpace,
}: {
  value: QzoneUpvotePreview | null;
  onClick?: () => void;
  pending?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onSpace?: (uin: string, nickname?: string) => void;
}) {
  const label = onClick && value?.upvoted ? '取消推' : '推';
  return (
    <QzoneLikesPopover
      label="推的人"
      trigger={
        <button
          type="button"
          aria-label={label}
          title={onClick ? label : '推过的人'}
          aria-pressed={onClick ? (value?.upvoted ?? false) : undefined}
          disabled={pending}
          onClick={onClick}
        >
          <Heart size={16} fill={value?.upvoted ? 'currentColor' : 'none'} />推{' '}
          <span className="weq-number">{value?.count ?? '?'}</span>
        </button>
      }
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

/** 普通说说复用原生详情缓存；只读取可见动态，不阻塞赞和正文。 */
export function QzonePostUpvotes({
  selfUin,
  hostUin,
  tid,
  time,
  enabled,
  refresh,
  onSpace,
}: {
  selfUin: string;
  hostUin: string;
  tid: string;
  time: number;
  enabled: boolean;
  refresh: number;
  onSpace?: (uin: string, nickname?: string) => void;
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
  const revision = `${refresh}:${retry}`;
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
  return (
    <>
      {tag ? (
        <button
          type="button"
          title={tag.text}
          onClick={() => {
            if (target) navigate?.(target);
            else if (publicTarget) openPublic?.();
          }}
          disabled={target ? !navigate : !publicTarget || !openPublic}
        >
          {tagIcon ? <ShimmerImage src={tagIcon} alt="" width={16} height={16} /> : null}
          {tag.text}
        </button>
      ) : null}
      {archive?.statusLabel ? <span>{archive.statusLabel}</span> : null}
      {archive?.showUpvote ? (
        <QzoneUpvoteAction
          value={value}
          loading={enabled && time > 0 && loading}
          error={error}
          onSpace={onSpace}
          onRetry={
            enabled && time > 0 && (error || !value)
              ? () => setRetry((current) => current + 1)
              : undefined
          }
        />
      ) : null}
      {selfUin === hostUin &&
      (archive?.canContribute || archive?.canUncontribute || archive?.canUnarchive) ? (
        <HoverPopover
          label="空友爱看管理操作"
          trigger={
            <button
              type="button"
              title="空友爱看管理"
              aria-label="空友爱看管理"
              disabled={write.disabled}
            >
              {write.pending ? (
                <Loader2 size={16} className="weq-spin" />
              ) : (
                <MoreHorizontal size={16} />
              )}
            </button>
          }
        >
          <div className="weq-qzn-archive-operations">
            {archive.canContribute ? (
              <button
                type="button"
                disabled={write.disabled}
                onClick={() => void perform('contribute')}
              >
                投稿至空友爱看
              </button>
            ) : null}
            {archive.canUncontribute ? (
              <button
                type="button"
                disabled={write.disabled}
                onClick={() => void perform('uncontribute')}
              >
                取消投稿
              </button>
            ) : null}
            {archive.canUnarchive ? (
              <button
                type="button"
                disabled={write.disabled}
                onClick={() => void perform('unarchive')}
              >
                取消收录
              </button>
            ) : null}
          </div>
        </HoverPopover>
      ) : null}
      {error && !archive?.showUpvote ? (
        <button
          type="button"
          title={error}
          aria-label="重试空友状态"
          onClick={() => setRetry((current) => current + 1)}
        >
          <RefreshCw size={14} />
        </button>
      ) : null}
    </>
  );
}
