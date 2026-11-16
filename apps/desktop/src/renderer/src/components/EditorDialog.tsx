import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import { useModalBackground } from '../lib/modalBackground';
import { useRenderDocument } from '../lib/renderDocument';
import { Modal } from './Dialog';
import { useTabActive } from './RetainedTabs';
import '../styles/editor-dialog.css';

/** 列表中的编辑任务独立呈现；沿用统一的关闭确认、焦点约束与返回位置。 */
export function EditorDialog({
  title,
  onClose,
  draft = null,
  busy = false,
  width = 560,
  bodyClassName = '',
  children,
}: {
  title: string;
  onClose: () => void;
  draft?: unknown;
  busy?: boolean;
  width?: number;
  bodyClassName?: string;
  children: ReactNode | ((requestClose: () => void) => ReactNode);
}) {
  const titleId = useId();
  const document = useRenderDocument();
  const trigger = useRef(document?.activeElement);
  const ref = useRef<HTMLDivElement>(null);
  const active = useTabActive();
  const close = useDraftClose(onClose, draft, busy);
  useModalBackground(ref, active);
  useLayoutEffect(
    () => () => {
      // 保存结束的同次提交可能稍后才重新启用入口，待 DOM 更新完成再补还焦点。
      queueMicrotask(() => {
        const target = trigger.current;
        if (
          document?.activeElement === document?.body &&
          target?.isConnected &&
          'focus' in target &&
          !target.closest('[hidden], [inert]')
        )
          (target as HTMLElement).focus({ preventScroll: true });
      });
    },
    [document],
  );
  useLayoutEffect(() => {
    if (active)
      ref.current
        ?.querySelector<HTMLElement>(
          'input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
        )
        ?.focus({ preventScroll: true });
  }, [active]);
  return (
    <Modal
      centered
      labelledBy={titleId}
      onClose={close.requestClose}
      dismissOnOutside={false}
      width={width}
      className="weq-message-modal weq-editor-dialog"
    >
      <div ref={ref} className="weq-dialog" aria-busy={busy}>
        <header className="weq-dialog-head">
          <h3 id={titleId} className="weq-dialog-title">
            {title}
          </h3>
          <button
            type="button"
            className="weq-dialog-x"
            title={`关闭${title}`}
            aria-label={`关闭${title}`}
            disabled={busy}
            onClick={close.requestClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className={`weq-dialog-body ${bodyClassName}`}>
          <DraftCloseContext.Provider value={close.drafts}>
            <fieldset className="weq-editor-fields" disabled={busy}>
              {typeof children === 'function' ? children(close.requestClose) : children}
            </fieldset>
          </DraftCloseContext.Provider>
        </div>
      </div>
    </Modal>
  );
}
