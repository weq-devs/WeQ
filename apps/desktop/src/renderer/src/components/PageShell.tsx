/**
 * 工作区页面的统一头部。
 *
 * 页面（维护工具 / 通知 / 收藏 / 装扮 …）以前各自画一条 `<header class="weq-xxx-head">`
 * 和一枚关闭按钮，再由 `styles/page-chrome.css` 用 `:is(…)` 选择器列表把它们强行改成一个
 * 样子 —— 于是同一处观感散落在「每个页面自己的 CSS」和「一层补丁」两个地方。
 *
 * 这里把这条栏收成一个组件：标题、图标、左侧返回、右侧操作、关闭按钮都由它渲染，
 * 观感只由 `styles/page-shell.css` 决定。页面自己的根节点和正文布局保持不变，
 * 所以迁移不需要动业务结构。
 *
 * 用法：
 *
 * ```tsx
 * <div className="weq-maintenance-dialog">
 *   <PageShell title="本地缓存" meta={account.name} onClose={onClose}>
 *     <div className="weq-maintenance-body">…</div>
 *   </PageShell>
 * </div>
 * ```
 */

import { useId, type ReactElement, type ReactNode } from 'react';
import { X } from 'lucide-react';
import '../styles/page-shell.css';

export function PageShell({
  title,
  titleId,
  icon,
  leading,
  meta,
  actions,
  onClose,
  closeLabel = '关闭',
  children,
}: {
  title: ReactNode;
  /** 面板里已有 `aria-labelledby` 引用的标题 id 时传进来，保持引用不断。 */
  titleId?: string;
  icon?: ReactNode;
  /** 头部最左侧的返回按钮等内容。 */
  leading?: ReactNode;
  /** 标题右侧的次要信息（账号、数量、在线状态等）。 */
  meta?: ReactNode;
  /** 头部右侧的操作按钮。 */
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
}): ReactElement {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;

  return (
    <>
      <header className="weq-page-head">
        {leading}
        {icon ? <span className="weq-page-icon">{icon}</span> : null}
        <h2 id={headingId} className="weq-page-title">
          {title}
        </h2>
        {meta ? <span className="weq-page-meta">{meta}</span> : null}
        {actions ? <div className="weq-page-actions">{actions}</div> : null}
        {onClose ? (
          <button
            type="button"
            className="weq-page-close"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X size={18} strokeWidth={2} />
          </button>
        ) : null}
      </header>
      {children}
    </>
  );
}
