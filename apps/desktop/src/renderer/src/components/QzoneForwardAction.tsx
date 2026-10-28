import { Repeat2 } from 'lucide-react';
import { QzoneLikesPopover } from './QzoneLikesPopover';

export function QzoneForwardAction({
  onClick,
  count = null,
  message = '转发名单接口暂不可用，暂无可信数据。',
}: {
  onClick: () => void;
  count?: number | null;
  message?: string;
}) {
  return (
    <QzoneLikesPopover
      label="转发列表"
      trigger={
        <button type="button" title="转发" aria-label="转发" onClick={onClick}>
          <Repeat2 size={16} />
          转发 {count ?? '?'}
        </button>
      }
    >
      <p className="weq-qzn-status">{message}</p>
    </QzoneLikesPopover>
  );
}
