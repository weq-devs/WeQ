import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportantMessagesButton } from '../../src/renderer/src/components/ImportantMessages';
import { ChatHeader } from '../../src/renderer/src/components/ChatHeader';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { importantTheme: useThemeStore });
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App() {
  const [located, setLocated] = useState('');
  const [count, setCount] = useState(0);
  const [group, setGroup] = useState('777');
  Object.assign(window, { changeImportantGroup: setGroup });
  return (
    <QueryClientProvider client={query}>
      <style>{`html,body,#root{height:100%;margin:0;min-width:0} .qa-important-chat{height:100%;color:var(--weq-fg-primary);background:var(--weq-chat-bg);font-family:system-ui;display:flex;flex-direction:column}.qa-important-chat>.chat-header{padding:10px 12px}.qa-important-chat .chat-title{min-width:0}.qa-important-chat .back-button{display:none}.qa-important-body{padding:24px;min-width:0;flex:1}.qa-important-located{padding:12px;border:1px solid var(--weq-border-subtle);max-width:320px}.qa-important-chat footer{padding:12px;border-top:1px solid var(--weq-border-subtle);font-size:13px}`}</style>
      <main className="qa-important-chat">
        <ChatHeader
          title="周末活动群"
          onBack={() => {}}
          actions={
            <ImportantMessagesButton
              groupCode={group}
              senderName={(uid) =>
                uid === 'u_long' ? '很长的群成员名片ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '小林'
              }
              onLocate={async (target) => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                setLocated(String(target.seq));
                setCount((value) => value + 1);
              }}
            />
          }
        />
        <section className="qa-important-body">
          <div className="qa-important-located">
            {located ? `已定位消息 ${located}` : '周六晚上八点见。'}
          </div>
        </section>
        <footer>周末活动群</footer>
        <output hidden data-locate-count={count} data-located={located} />
      </main>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
