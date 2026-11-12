import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * 资料页页头契约（联系人与群共用）：
 *
 * ```tsx
 * <ProfilePageHeader
 *   title="联系人资料"          // 页面标题，13px 600，只在工具条出现一次
 *   onClose={...}               // 关闭/返回，固定右上角，触控热区 44px
 *   identity={<ContactIdentity person={person} pendant />}   // 身份区（头像/标题/副标题/编号）
 *   actions={<ContactActions ... />}                         // 主操作 + 次操作
 * />
 * ```
 *
 * 约定：
 * - 工具条只放「标题 + 关闭」，不放导航或第二套目录；章节标题由 ProfileWorkspace 输出。
 * - 默认纵向布局；联系人使用 split，将名片身份正文与操作区分列。
 * - 两者都在页头，不随正文滚动；联系人长身份内容可在页头内滚动。
 * - 身份正文由传入组件决定，外壳不重复输出字段。
 * - 窄屏 padding 降为 12/14，操作行允许换行，不隐藏任何主操作。
 */
export function ProfilePageHeader({
  title,
  identity,
  actions,
  onClose,
  closeLabel = '关闭资料',
  layout = 'stacked',
}: {
  title: string;
  identity: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  layout?: 'stacked' | 'split';
}) {
  return (
    <>
      <div className="weq-profile-page-toolbar">
        <strong>{title}</strong>
        <button
          type="button"
          className="weq-profile-page-close"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <header
        className={`weq-profile-page-header${layout === 'split' ? ' weq-profile-page-header--split' : ''}`}
      >
        {layout === 'split' ? (
          <>
            <div className="weq-profile-page-identity">{identity}</div>
            {actions ? <div className="weq-profile-page-actions">{actions}</div> : null}
          </>
        ) : (
          <>
            {identity}
            {actions}
          </>
        )}
      </header>
    </>
  );
}
