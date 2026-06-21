/**
 * 设置弹窗。
 *
 * 沿用 weq-template-credit-layer 的灯箱风格：半透明遮罩 + 居中卡片，
 * 左侧分类导航 + 右侧分类内容。后续新增设置分类直接在
 * `SETTINGS_SECTIONS` 里加一项即可。
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Info, Settings2, User, X } from 'lucide-react';
import { GlobalSettingsSection } from './settings/GlobalSettingsSection';
import { AccountBasicsSection } from './settings/AccountBasicsSection';

type SectionId = 'global' | 'account' | 'about';

interface SettingsSection {
  id: SectionId;
  label: string;
  icon: ReactElement;
  render: () => ReactNode;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'global',
    label: '全局设置',
    icon: <Settings2 size={16} strokeWidth={1.8} />,
    render: () => <GlobalSettingsSection />,
  },
  {
    id: 'account',
    label: '账号基础',
    icon: <User size={16} strokeWidth={1.8} />,
    render: () => <AccountBasicsSection />,
  },
  {
    id: 'about',
    label: '关于',
    icon: <Info size={16} strokeWidth={1.8} />,
    render: () => (
      <div className="weq-settings-section">
        <h3 className="weq-settings-section-title">消息列表说明</h3>
        <p>
          当前消息列表基于{' '}
          <a href="https://github.com/dogxii/webark-im-template" target="_blank" rel="noreferrer">
            dogxii/webark-im-template
          </a>{' '}
          项目进行适配与修改。
        </p>
        <p>感谢 dogxii 及原项目贡献者提供的优秀 IM 模板基础。</p>
      </div>
    ),
  },
];

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const [activeId, setActiveId] = useState<SectionId>('global');

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const active = SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0]!;

  return (
    <div
      className="weq-settings-layer"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="weq-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="weq-settings-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <nav className="weq-settings-nav" aria-label="设置分类">
          <h2 id="weq-settings-title" className="weq-settings-nav-title">设置</h2>
          <ul>
            {SETTINGS_SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`weq-settings-nav-item${s.id === activeId ? ' is-active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <span className="weq-settings-nav-icon">{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="weq-settings-body">{active.render()}</div>
      </section>
    </div>
  );
}
