import { createPortal } from 'react-dom';
import { useAppLock } from '../../state/lock';
import { Modal } from '../Dialog';
import { PanelLoading } from '../LoadingIndicator';
import '../../styles/call.css';
import '../../styles/group-call.css';

export function CallWindowLoading({
  popup,
  inline,
  title,
  width,
  className,
}: {
  popup: Window | null;
  inline: boolean;
  title: string;
  width: number | string;
  className: string;
}) {
  const locked = useAppLock((state) => state.locked);
  if (popup && !popup.closed)
    return createPortal(
      locked ? (
        <div className="weq-call-locked" role="status">
          应用已锁定
        </div>
      ) : (
        <div className="weq-call-backdrop">
          <PanelLoading />
        </div>
      ),
      popup.document.body,
    );
  return inline && !locked ? (
    <Modal title={title} width={width} className={className} centered>
      <PanelLoading />
    </Modal>
  ) : null;
}
