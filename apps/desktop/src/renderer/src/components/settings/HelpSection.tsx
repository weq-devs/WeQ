/**
 * 帮助内容：设置按 page 直接展示，旧帮助弹窗保留原来的子页切换。
 *
 * 三个子页（顶部 tab 切换）：
 *   - 日志查看   LogViewerPanel（WeQ / nt_helper 日志，实时尾部 + 向上回溯）
 *   - 常见问题   FaqPanel（resources/help/faq.md 渲染）
 *   - 反馈 bug   BugReportPanel（hexdump / gh / QQ 群）
 */

import { useState, type ReactElement } from 'react';
import { Bug, HelpCircle, ScrollText } from 'lucide-react';
import { LogViewerPanel } from './LogViewerPanel';
import { FaqPanel } from './FaqPanel';
import { BugReportPanel } from './BugReportPanel';
import { GlobalSettingsSection } from './GlobalSettingsSection';
import '../../styles/help-settings.css';

type HelpTabId = 'logs' | 'faq' | 'feedback';

const HELP_TABS: ReadonlyArray<{ id: HelpTabId; label: string; icon: ReactElement }> = [
  { id: 'logs', label: '日志', icon: <ScrollText size={14} strokeWidth={1.9} aria-hidden /> },
  { id: 'faq', label: '常见问题', icon: <HelpCircle size={14} strokeWidth={1.9} aria-hidden /> },
  { id: 'feedback', label: '反馈', icon: <Bug size={14} strokeWidth={1.9} aria-hidden /> },
];

export function HelpSection({ page }: { page?: HelpTabId } = {}): ReactElement {
  const [tab, setTab] = useState<HelpTabId>('logs');
  const active = page ?? tab;

  return (
    <div className="weq-help">
      {page === 'logs' ? <GlobalSettingsSection section="logs" /> : null}
      {!page ? (
        <div className="weq-help-tabs" role="tablist" aria-label="帮助子页面">
          {HELP_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`weq-help-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="weq-help-body" role={page ? undefined : 'tabpanel'}>
        {active === 'logs' ? <LogViewerPanel /> : null}
        {active === 'faq' ? <FaqPanel /> : null}
        {active === 'feedback' ? <BugReportPanel /> : null}
      </div>
    </div>
  );
}
