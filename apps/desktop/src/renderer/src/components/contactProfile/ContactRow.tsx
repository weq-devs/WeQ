/**
 * 联系人资料的行模型：名片、资料页、名片预览共用同一个行组件。
 *
 * 为什么不复用旧的 `.weq-profile-row`：那套是「小名片」时代的 space-between 布局，
 * 值靠右、逐行画线；资料页需要的是固定 label 列 + 值左对齐换行。两者混用会让同一份
 * 数据在不同宿主里长成三种样子（审计 B2/B3）。这里给出唯一实现，旧行通过
 * `profile-workspace.css` 里的容器级归一化跟随同一套网格，不需要逐个改第三方组件。
 *
 * 约定（设计契约 v1）：
 * - label 固定 96px、13px muted；值 13px、左对齐、可换行。
 * - 可选内容为空时整行不渲染（`empty` 可显式覆盖判断）。
 * - 协议字段不进正文，由 `ContactTechnicalDetails` 收进默认折叠的技术详情。
 */

import { useId, type ReactNode } from 'react';

function isBlank(value: ReactNode): boolean {
  if (value === null || value === undefined || value === false || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

export function ContactRow({
  label,
  icon,
  value,
  children,
  empty,
  mono,
  onActivate,
  activateTitle,
  valueClassName,
}: {
  label: string;
  /** label 前的小图标，与设置页 SectionHeader 的图标语言一致；不是每行都需要。 */
  icon?: ReactNode;
  /** 纯文本值（与 children 二选一）。 */
  value?: ReactNode;
  /** 结构化内容（标签、按钮、图片……）放在值列里，保持 label 对齐。 */
  children?: ReactNode;
  /** 显式声明这一行没有内容；默认按 value/children 判断。 */
  empty?: boolean;
  /** 等宽展示（编号、UUID 一类），仍然可选中复制。 */
  mono?: boolean;
  /** 点值进入编辑/详情；拖动选择文本时不触发。 */
  onActivate?: () => void;
  activateTitle?: string;
  valueClassName?: string;
}) {
  const content = children ?? value;
  if (empty ?? isBlank(content)) return null;
  const className = `weq-profile-data-row${valueClassName ? ` ${valueClassName}` : ''}`;
  return (
    <div className={className}>
      <span className="weq-profile-data-label">
        {icon ? (
          <span className="weq-profile-data-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        {label}
      </span>
      <div className={`weq-profile-data-value${mono ? ' is-mono' : ''}`} data-privacy-sensitive>
        {onActivate ? (
          <button
            type="button"
            className="weq-profile-data-action"
            title={activateTitle}
            onClick={(event) => {
              const selection = window.getSelection();
              if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
                onActivate();
            }}
          >
            {content}
          </button>
        ) : (
          content
        )}
      </div>
    </div>
  );
}

/** 分区：名片里的小标题；资料页章节标题由 ProfileWorkspace 提供。 */
export function ContactSection({
  title,
  action,
  hideTitle = false,
  children,
}: {
  title: string;
  action?: ReactNode;
  /** 只有一个分区时不必重复小标题，避免「小标题 + 两行数据」的冗余。 */
  hideTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="weq-profile-section-block">
      {hideTitle && !action ? null : (
        <header className="weq-profile-section-head">
          {hideTitle ? <span /> : <h3 className="weq-profile-subtitle">{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** 协议字段（QID / NT UID / 原始编码）只在这里出现，默认折叠。 */
export function ContactTechnicalDetails({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <details className="weq-profile-tech" aria-labelledby={id}>
      <summary id={id}>技术详情</summary>
      <div className="weq-profile-tech-body">{children}</div>
    </details>
  );
}

/** 局部失败：保留已有内容，给出可行动的重试入口。 */
export function ContactInlineError({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <p className="weq-profile-inline-error" role="alert">
      <span>{message}</span>
      <button type="button" disabled={retrying} onClick={onRetry}>
        {retrying ? '正在重试…' : '重试'}
      </button>
    </p>
  );
}

/** 空态：一句话说明 + 可选操作，不用「未知 / 暂不支持」占位。 */
export function ContactEmptyState({ children }: { children: ReactNode }) {
  return <p className="weq-profile-empty">{children}</p>;
}
