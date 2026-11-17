import type { ReactNode } from 'react';
import { ImagePlus, Save } from 'lucide-react';
import { QQWriteResult } from '../QQWriteControls';
import type { DangerLevel } from '../Dialog';
import '../../styles/qq-actions.css';
import type { useQQAction } from './shared.shared';

export function ActionIcon({
  label,
  text,
  children,
  disabled,
  title,
  danger,
  onClick,
}: {
  label: string;
  /** 紧凑工具条里可同时显示的动作名称；图标按钮仍由 label 提供完整可访问名称。 */
  text?: string;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  danger?: DangerLevel;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-qq-action
      data-danger={danger}
      className={`weq-set-iconbtn${text ? ' has-label' : ''}`}
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {text && <span className="weq-set-iconbtn-label">{text}</span>}
    </button>
  );
}
export function ActionFeedback({ action }: { action: ReturnType<typeof useQQAction> }) {
  return (
    <>
      <QQWriteResult result={action.result} />
      {action.error && <QQWriteResult result={{ text: action.error, error: true }} />}
    </>
  );
}
export function SaveAction({
  disabled,
  onClick,
  label = '保存',
}: {
  disabled?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <ActionIcon label={label} disabled={disabled} onClick={onClick}>
      <Save size={16} />
    </ActionIcon>
  );
}
export function ImageAction({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <ActionIcon label="选择图片" disabled={disabled} onClick={onClick}>
      <ImagePlus size={16} />
    </ActionIcon>
  );
}
