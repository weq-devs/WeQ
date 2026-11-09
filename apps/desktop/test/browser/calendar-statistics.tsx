import { createRoot } from 'react-dom/client';
import { CalendarTaskDetails } from '../../src/renderer/src/components/CalendarTaskDetails';
import { CalendarNavigationContext } from '../../src/renderer/src/lib/calendarNavigation';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/conversation-overview-calendar.css';

document.body.style.cssText =
  'margin:0;padding:16px;background:var(--weq-bg-surface);color:var(--weq-fg-primary);';
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 720, margin: '0 auto' }}>
    <h2 style={{ fontSize: 18 }}>会话日历 · 2026-11</h2>
    <CalendarNavigationContext.Provider
      value={() => {
        document.body.dataset.located = 'true';
      }}
    >
      <CalendarTaskDetails taskId="fixture" scope={{ uin: 'fixture', configId: 'live' }} running />
    </CalendarNavigationContext.Provider>
  </main>,
);
