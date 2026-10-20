/**
 * 群成员管理弹窗（改群昵称 / 踢出群聊）。
 *
 * 与「群公告 / 群精华」等卡片同层：挂在 MainView 里，**不放在 im-template**，
 * 免得继承聊天区的排版 / 装扮字体，样式也跟着这些卡片走。
 *
 * 两个弹窗都只负责收集输入 / 二次确认，真正的发包由应用层（MainView）注入的
 * `onConfirm` 负责；不做任何乐观渲染。
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { X } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import { QQGroupMemberEditor } from './QQGroupMemberControls';

function DialogHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}): ReactElement {
  return (
    <header className="group-member-header">
      <div>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <button className="icon-button" type="button" title="关闭" onClick={onClose}>
        <X size={18} />
      </button>
    </header>
  );
}

export function GroupMemberTitleDialog({
  groupCode,
  uid,
  memberName,
  onClose,
}: {
  groupCode: string;
  uid: string;
  memberName: string;
  onClose: () => void;
}): ReactElement {
  return (
    <OverlayLayer
      presentation="popover"
      title="编辑专属头衔"
      className="modal-scrim group-member-scrim"
      onClose={onClose}
    >
      <section
        className="group-member-dialog weq-set"
        role="dialog"
        aria-label="编辑专属头衔"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <DialogHeader title="编辑专属头衔" subtitle={memberName} onClose={onClose} />
        <div className="group-member-body">
          <QQGroupMemberEditor groupCode={groupCode} uid={uid} field="title" />
        </div>
      </section>
    </OverlayLayer>
  );
}

export function GroupMemberRenameDialog({
  memberName,
  initialCard,
  busy,
  onCancel,
  onConfirm,
}: {
  memberName: string;
  initialCard?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (card: string) => void;
}): ReactElement {
  const [value, setValue] = useState(initialCard ?? '');

  return (
    <OverlayLayer
      presentation="popover"
      className="modal-scrim group-member-scrim"
      onClose={onCancel}
    >
      <section
        className="group-member-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <DialogHeader title="修改群名片" subtitle={memberName} onClose={onCancel} />
        <div className="group-member-body">
          <input
            className="group-member-input"
            value={value}
            placeholder="输入新的群名片（留空 = 清除）"
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onConfirm(value);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
            }}
          />
          <p className="group-member-hint">留空并保存将清除该成员的群名片。</p>
        </div>
        <footer className="group-member-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => onConfirm(value)}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </OverlayLayer>
  );
}

export function GroupMemberKickDialog({
  memberName,
  busy,
  onCancel,
  onConfirm,
}: {
  memberName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <OverlayLayer className="modal-scrim group-member-scrim" onClose={onCancel}>
      <section
        className="group-member-dialog is-confirm"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <DialogHeader title="踢出群聊" subtitle={memberName} onClose={onCancel} />
        <div className="group-member-body">
          <p className="group-member-text">确定将「{memberName}」移出群聊？该操作不可撤销。</p>
        </div>
        <footer className="group-member-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="is-danger" onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : '踢出'}
          </button>
        </footer>
      </section>
    </OverlayLayer>
  );
}
