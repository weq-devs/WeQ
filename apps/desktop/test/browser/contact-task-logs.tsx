import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BackgroundTaskDetails } from '../../src/renderer/src/components/tasks/BackgroundTaskDetails';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { taskLogQa: { theme: useThemeStore } });
function Fixture() {
  const [version, setVersion] = useState(1);
  return (
    <main style={{ padding: 16, maxWidth: 760, margin: 'auto', color: 'var(--weq-fg-primary)' }}>
      <h2 style={{ fontSize: 16 }}>更新群成员名单</h2>
      <button type="button" onClick={() => setVersion((value) => value + 1)}>
        模拟日志更新
      </button>
      <BackgroundTaskDetails
        scope={null}
        refresh={async () => {}}
        entry={{
          source: 'host',
          task: {
            id: 'synthetic-task',
            name: '更新群成员名单',
            kind: 'contacts',
            status: 'running',
            startedAt: 1,
            updatedAt: version,
            actions: [],
            subtasks: [
              { label: '好友', done: 25, total: 50, failed: 0 },
              { label: '群聊', done: version, total: 100, failed: 1 },
            ],
          },
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
);
