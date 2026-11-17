import { useId } from 'react';
import { X } from 'lucide-react';
import { Modal } from './Dialog';
import { QqDebugCopy } from './QqDebugCopy';
import '../styles/qq-debug-copy.css';

export function QqDebugCopyDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal
      open
      centered
      labelledBy={titleId}
      className="weq-qq-debug-modal"
      onClose={onClose}
      width={520}
    >
      <div className="weq-dialog-head">
        <h3 id={titleId} className="weq-dialog-title">
          QQ 调试副本
        </h3>
        <button
          type="button"
          className="weq-dialog-x"
          title="关闭"
          aria-label="关闭副本设置"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="weq-dialog-body">
        <QqDebugCopy />
      </div>
    </Modal>
  );
}
