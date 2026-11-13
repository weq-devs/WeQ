import { useCallback, useState, type ReactNode } from 'react';
import { Repeat2 } from 'lucide-react';
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
  autoRead = true,
}: {
  onClick: () => void;
  count?: number | null;
  message?: string;
  target?: QzoneForwardTarget;
  onSpace?: (uin: string, nickname?: string) => void;
  renderContent?: (content: string) => ReactNode;
  paused?: boolean;
  autoRead?: boolean;
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
      keepMounted={Boolean(target)}
      trigger={
        <button type="button" title="转发" aria-label="转发" onClick={onClick}>
          <Repeat2 size={16} />
          转发 {displayed ?? '?'}
        </button>
      }
    >
      {target ? (
        (open: boolean) => (
          <QzoneForwardList
            key={targetId}
            target={target}
            onCount={onCount}
            onSpace={onSpace}
            renderContent={renderContent}
            paused={paused}
            enabled={autoRead || open}
            open={open}
          />
        )
      ) : (
        <p className="weq-qzn-status">{message}</p>
      )}
    </QzoneLikesPopover>
  );
}
