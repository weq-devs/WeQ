import { Maximize2, X } from 'lucide-react';
import '../styles/contact-card.css';

/** 联系人与群快速名片共用右上角操作，避免旧弹窗按钮样式相互覆盖。 */
export function ProfileCardControls({
  onExpand,
  onClose,
  expandLabel = '打开完整资料页',
  closeLabel = '关闭',
}: {
  onExpand?: () => void;
  onClose: () => void;
  expandLabel?: string;
  closeLabel?: string;
}) {
  return (
    <header className="weq-profile-card-controls">
      {onExpand ? (
        <button type="button" title={expandLabel} aria-label={expandLabel} onClick={onExpand}>
          <Maximize2 size={16} aria-hidden />
        </button>
      ) : null}
      <button type="button" title={closeLabel} aria-label={closeLabel} onClick={onClose}>
        <X size={16} aria-hidden />
      </button>
    </header>
  );
}
