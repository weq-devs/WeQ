import { useEffect, useRef, useState } from 'react';
import { Heart, Loader2, RefreshCw } from 'lucide-react';
import type { QzoneUpvotePreview } from '@weq/protocol';
import { client } from '../trpc/client';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { QzoneLikesPopover } from './QzoneLikesPopover';
import { QzonePersonIdentity } from './QzoneProfileAvatar';
import { QqAvatar } from './QqAvatar';

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
          {value?.count ?? '?'}
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
          client.account.qzone.upvotes.query({
            selfUin,
            hostUin,
            tid,
            time,
            requestId,
            refresh: completed.current !== null || retry > 0,
          }),
        true,
      )
      .then((result) => {
        if (!active) return;
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
  return (
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
  );
}
