import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquare } from 'lucide-react';
import { TimeRangePicker } from '../../src/renderer/src/views/export/TimeRangePicker';
import { ContactScopePicker } from '../../src/renderer/src/views/export/ContactScopePicker';
import { ScheduleSettings } from '../../src/renderer/src/components/tasks/ScheduleSettings';
import { DEFAULT_OPTIONS, type TimeRange } from '../../src/renderer/src/views/export/types';
import { useThemeStore, type ThemeComponentStyle } from '../../src/renderer/src/state/theme';
import { contrastRatio } from '../../src/shared/theme_colors';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-card.css';
import '../../src/renderer/src/styles/workspace-tools.css';
import '../../src/renderer/src/styles/workspace-menu.css';

Object.assign(window, {
  reviewQa: {
    theme: (mode: 'light' | 'dark', accent: string, style: ThemeComponentStyle) => {
      useThemeStore.getState().setPreference(mode);
      useThemeStore.getState().setAccent(accent);
      useThemeStore.getState().setComponentStyle(style);
    },
    contrast: () => {
      const button = document.querySelector('.weq-contact-secondary')!;
      const css = getComputedStyle(button);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const color = (input: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = input;
        context.fillRect(0, 0, 1, 1);
        return `#${[...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((part) => part.toString(16).padStart(2, '0'))
          .join('')}`;
      };
      const bg =
        css.backgroundColor === 'rgba(0, 0, 0, 0)'
          ? getComputedStyle(document.body).backgroundColor
          : css.backgroundColor;
      return contrastRatio(color(css.color), color(bg));
    },
  },
});
function Fixture() {
  const [range, setRange] = useState<TimeRange>({ preset: 'all', start: null, end: null });
  const [selected, setSelected] = useState<string[]>();
  return (
    <main style={{ maxWidth: 720, margin: 'auto', padding: 12, boxSizing: 'border-box' }}>
      <div className="weq-contact-actions">
        <button type="button" className="weq-contact-secondary">
          <MessageSquare size={14} />
          打开会话
        </button>
      </div>
      <TimeRangePicker value={range} onChange={setRange} />
      <ContactScopePicker
        items={[{ uid: 'synthetic', uin: '0', name: '合成联系人', categoryId: 0 }]}
        selected={selected}
        onChange={setSelected}
        loading={false}
        error={false}
        onRetry={() => {}}
        conditionLabel="全部好友"
      />
      <ScheduleSettings
        schedule={{
          id: 'synthetic',
          name: '合成任务',
          format: 'json',
          formats: ['json'],
          conversations: [],
          schedule: { mode: 'daily', time: '08:00', intervalHours: 6 },
          options: { ...DEFAULT_OPTIONS },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          nextRunAt: null,
          history: [],
        }}
      />
      <button type="button" className="weq-set-btn weq-set-btn-danger">
        退出群聊
      </button>
    </main>
  );
}
document.body.style.cssText =
  'margin:0;background:var(--weq-bg-surface);color:var(--weq-fg-primary);font-family:system-ui;';
createRoot(document.getElementById('root')!).render(<Fixture />);
