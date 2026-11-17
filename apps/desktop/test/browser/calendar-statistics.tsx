import { createRoot } from 'react-dom/client';
import { CalendarTaskDetails } from '../../src/renderer/src/components/CalendarTaskDetails';
import { CalendarNavigationContext } from '../../src/renderer/src/lib/calendarNavigation';
import { ConversationOverviewCalendar } from '../../src/renderer/src/components/ConversationOverviewCalendar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CONVERSATION_VIEWS } from '../../src/renderer/src/lib/conversationViews';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/conversation-overview-calendar.css';

document.body.style.cssText =
  'margin:0;padding:16px;background:var(--weq-bg-surface);color:var(--weq-fg-primary);';
const overview = new URLSearchParams(location.search).has('overview');
const scope =
  CONVERSATION_VIEWS.find((view) => view === new URLSearchParams(location.search).get('view')) ??
  'regular';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    {overview ? (
      <ConversationOverviewCalendar
        targets={[{ kind: 'c2c', conv: 'fixture', name: '测试会话', avatar: null, ancestors: [] }]}
        scope={scope}
        query=""
        ready
        binding={{ expectedAccountUin: 'fixture', expectedAccountConfigId: 'live' }}
        onClose={() => {
          document.body.dataset.closed = 'true';
        }}
        onLocate={() => {
          document.body.dataset.located = 'true';
        }}
      />
    ) : (
      <main style={{ maxWidth: 720, margin: '0 auto' }}>
        <h2 style={{ fontSize: 18 }}>会话日历 · 2026-11</h2>
        <CalendarNavigationContext.Provider
          value={() => {
            document.body.dataset.located = 'true';
          }}
        >
          <CalendarTaskDetails
            taskId="fixture"
            scope={{ uin: 'fixture', configId: 'live' }}
            running
          />
        </CalendarNavigationContext.Provider>
      </main>
    )}
  </QueryClientProvider>,
);
