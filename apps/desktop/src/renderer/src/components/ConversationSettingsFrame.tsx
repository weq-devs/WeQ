import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { WindowSurface } from './WindowSurface';
import '../styles/conversation-settings.css';

/** 普通会话、克隆体与克隆群聊共用原位设置窗格和分类导航。 */
export function ConversationSettingsFrame<T extends string>({
  title,
  subtitle,
  sections,
  value,
  onValueChange,
  onClose,
  anchor,
  children,
}: {
  title: string;
  subtitle: string;
  sections: readonly { id: T; label: string; icon: ReactNode }[];
  value: T;
  onValueChange: (value: T) => void;
  onClose: () => void;
  anchor?: HTMLElement;
  children: ReactNode;
}) {
  return (
    <WindowSurface
      mode="anchored"
      anchor={anchor}
      width={640}
      title={title}
      className="weq-conversation-settings-pane"
      onClose={onClose}
    >
      <section className="weq-cvs-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <button
          className="weq-cvs-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <nav className="weq-cvs-nav" aria-label={`${title}分类`}>
          <div className="weq-cvs-nav-head">
            <strong>{title}</strong>
            <span title={subtitle}>{subtitle}</span>
          </div>
          <ul>
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className={`weq-cvs-nav-item${value === section.id ? ' is-on' : ''}`}
                  onClick={() => onValueChange(section.id)}
                >
                  <span className="weq-cvs-nav-icon">{section.icon}</span>
                  <span>{section.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="weq-cvs-body">{children}</div>
      </section>
    </WindowSurface>
  );
}
