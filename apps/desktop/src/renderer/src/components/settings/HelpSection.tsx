/**
 * 帮助内容：设置按 page 直接展示，旧帮助弹窗保留原来的子页切换。
 *
 * 三个子页（顶部 tab 切换）：
 *   - 日志与性能配置、独立查看窗口入口
 *   - 常见问题   FaqPanel（resources/help/faq.md 渲染）
 *   - 反馈 bug   BugReportPanel（hexdump / gh / QQ 群）
 */

import { useState, type ReactElement } from 'react';
import { SettingsPageIcon } from './pageIcons';
import LogPerformanceSettings from './LogPerformanceSettings';
import { FaqPanel } from './FaqPanel';
import { BugReportPanel } from './BugReportPanel';
import '../../styles/help-panels.css';
import '../../styles/help-settings.css';

type HelpTabId = 'logs' | 'faq' | 'feedback';

const HELP_TABS: ReadonlyArray<{ id: HelpTabId; label: string; icon: ReactElement }> = [
  { id: 'logs', label: '日志', icon: <SettingsPageIcon page="logs" /> },
  { id: 'faq', label: '常见问题', icon: <SettingsPageIcon page="faq" /> },
  { id: 'feedback', label: '反馈', icon: <SettingsPageIcon page="feedback" /> },
];

export function HelpSection({ page }: { page?: HelpTabId } = {}): ReactElement {
  const [tab, setTab] = useState<HelpTabId>('logs');
  const active = page ?? tab;

  return (
    <div className="weq-help">
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
        {active === 'logs' ? <LogPerformanceSettings /> : null}
        {active === 'faq' ? <FaqPanel /> : null}
        {active === 'feedback' ? <BugReportPanel /> : null}
      </div>
    </div>
  );
}
