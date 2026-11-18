import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { WindowSurface } from './WindowSurface';
import '../styles/conversation-settings.css';

/** 各类会话共用原位设置窗格、分类导航和分组标题。 */
export function ConversationSettingsFrame<T extends string>({
  title,
  subtitle,
  sections,
  value,
  onValueChange,
  onClose,
  anchor,
  sectionDescription,
  children,
}: {
  title: string;
  subtitle: string;
  sections: readonly { id: T; label: string; icon: ReactNode }[];
  value: T;
  onValueChange: (value: T) => void;
  onClose: () => void;
  anchor?: HTMLElement;
  sectionDescription?: ReactNode;
  children: ReactNode;
}) {
  const activeSection = sections.find((section) => section.id === value);
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
                  aria-current={value === section.id ? 'true' : undefined}
                  onClick={() => onValueChange(section.id)}
                >
                  <span className="weq-cvs-nav-icon">{section.icon}</span>
                  <span>{section.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="weq-cvs-body">
          {activeSection ? (
            <header className="weq-cvs-body-head">
              <span className="weq-cvs-body-icon" aria-hidden>
                {activeSection.icon}
              </span>
              <strong>{activeSection.label}</strong>
              {sectionDescription ? (
                <span className="weq-cvs-body-desc">{sectionDescription}</span>
              ) : null}
            </header>
          ) : null}
          {children}
        </div>
      </section>
    </WindowSurface>
  );
}
