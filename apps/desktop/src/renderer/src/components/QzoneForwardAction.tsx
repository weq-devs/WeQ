import { useCallback, useState, type ReactNode } from 'react';
import { Repeat2, UsersRound } from 'lucide-react';
import { QzoneLikesPopover } from './QzoneLikesPopover';
import { QzoneForwardList, type QzoneForwardTarget } from './QzoneForwardList';

export function QzoneForwardAction({
  onClick,
  count = null,
  message = '转发名单接口暂不可用，暂无可信数据。',
  target,
  onSpace,
  renderContent,
  paused,
}: {
  onClick: () => void;
  count?: number | null;
  message?: string;
  target?: QzoneForwardTarget;
  onSpace?: (uin: string, nickname?: string) => void;
  renderContent?: (content: string) => ReactNode;
  paused?: boolean;
}) {
  const targetId = target ? `${target.selfUin}:${target.hostUin}:${target.tid}` : '';
  const [observed, setObserved] = useState<{ targetId: string; total: number | null } | null>(null);
  const onCount = useCallback(
    (total: number | null) => setObserved({ targetId, total }),
    [targetId],
  );
  const displayed = observed?.targetId === targetId ? observed.total : count;
  return (
    <QzoneLikesPopover
      label="转发列表"
      openOnClick={Boolean(target)}
      trigger={
        <>
          <button type="button" title="转发" aria-label="转发" onClick={onClick}>
            <Repeat2 size={16} />
            转发 {displayed ?? '?'}
          </button>
          {target ? (
            <button
              className="weq-qzn-forward-people"
              type="button"
              title="查看转发者"
              aria-label="查看转发者"
            >
              <UsersRound size={14} />
            </button>
          ) : null}
        </>
      }
    >
      {target ? (
        <QzoneForwardList
          key={targetId}
          target={target}
          onCount={onCount}
          onSpace={onSpace}
          renderContent={renderContent}
          paused={paused}
        />
      ) : (
        <p className="weq-qzn-status">{message}</p>
      )}
    </QzoneLikesPopover>
  );
}
