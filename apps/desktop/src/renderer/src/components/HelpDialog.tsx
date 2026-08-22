/**
 * 帮助弹窗 —— 主窗口「更多功能 → 帮助」。
 * 原为设置页里的「帮助」子页，随妙妙工具重构迁入更多功能菜单。
 */

import type { ReactElement } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { HelpSection } from './settings/HelpSection';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

export function HelpDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  useEscapeToClose(onClose);

  if (!open) return null;

  return (
    <div className="weq-help-layer" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section
        className="weq-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-help-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="weq-help-dialog-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <header className="weq-help-dialog-head">
          <span className="weq-help-dialog-head-icon">
            <HelpCircle size={17} strokeWidth={1.9} />
          </span>
          <h2 id="weq-help-dialog-title">帮助</h2>
        </header>
        <div className="weq-help-dialog-body">
          <HelpSection />
        </div>
      </section>
    </div>
  );
}
