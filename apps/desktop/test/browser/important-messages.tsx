import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { GapMessagesModal } from '../../src/renderer/src/components/compose/GapMessagesModal';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import {
  ReplyJumpContext,
  type ReplyJumpTarget,
} from '../../src/renderer/src/state/messageContext';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { importantTheme: useThemeStore });
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const demo = createTemplateDemoData();
const original = demo.conversations.find((item) => item.type === 'group')!;
const peer = { ...demo.user, id: 'u_peer', displayName: '小林', avatarUrl: null };
const longPeer = {
  ...peer,
  id: 'u_long',
  displayName: '很长的群成员名片ABCDEFGHIJKLMNOPQRSTUVWXYZ',
};
const dock = {
  unread: 14,
  stops: [
    { kind: 'atMe' as const, seq: '1024' },
    { kind: 'replyMe' as const, seq: '1023' },
    { kind: 'unread' as const, seq: '1000' },
  ],
};
function App() {
  const [located, setLocated] = useState('1024');
  const [count, setCount] = useState(0);
  const [group, setGroup] = useState('777');
  const [preview, setPreview] = useState(false);
  Object.assign(window, { changeImportantGroup: setGroup });
  const conversation = {
    ...original,
    id: group,
    members: [peer, longPeer],
    group: { ...original.group, identityValue: group, id: group, name: '周末活动群' },
  };
  const messages = [-1, 0, 1].map((offset) => ({
    id: `context-${Number(located) + offset}`,
    msgSeq: String(Number(located) + offset),
    msgId: String(9000 + offset),
    conversationId: group,
    senderId: 'u_peer',
    sender: peer,
    body:
      offset === -1
        ? '我来确认一下周六活动的安排。'
        : offset === 0
          ? `周六活动 ${located}：请在晚上八点前确认安排。`
          : '好的，到时候在校门口集合。',
    createdAt: new Date(1794801600000 + offset * 60000).toISOString(),
  }));
  async function locate(target: ReplyJumpTarget) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if ((window as unknown as { importantLocateError?: boolean }).importantLocateError)
      throw new Error('暂时无法定位，请重试');
    setLocated(String(target.seq));
    setCount((value) => value + 1);
  }
  return (
    <QueryClientProvider client={query}>
      <ContentSelectionProvider>
        <ReplyJumpContext.Provider value={locate}>
          <style>{`html,body,#root{height:100%;margin:0;min-width:0}.qa-important-chat{height:100%;font-family:system-ui;background:var(--weq-chat-bg)}.qa-important-chat .message-scroll{background:var(--weq-chat-bg)}.qa-important-chat .chat-pane{height:100%}.qa-preview{position:fixed;inset:50px 20px;max-width:520px;z-index:20;background:var(--weq-bg-surface)}.qa-preview .weq-private-preview-inline{height:100%}`}</style>
          <main className="qa-important-chat">
            <ChatPane
              user={demo.user}
              conversation={conversation}
              messages={messages}
              composerVisible={false}
              loading={false}
              atLatest={false}
              preference={conversation.preference}
              draft=""
              onDraftChange={() => {}}
              onBack={() => {}}
              onSend={async () => {}}
              unreadDock={dock}
              headerActions={
                <button
                  type="button"
                  className="icon-button"
                  title="预览会话"
                  aria-label="预览会话"
                  onClick={() => setPreview(true)}
                >
                  预览
                </button>
              }
            />
            {preview ? (
              <div className="qa-preview">
                <GapMessagesModal
                  preview
                  embedded
                  conversation={conversation}
                  user={demo.user}
                  messages={messages}
                  loading={false}
                  loadingMore={false}
                  error={null}
                  hasMore={false}
                  moreFailed={false}
                  totalCount={messages.length}
                  onLoadMore={() => {}}
                  onClose={() => setPreview(false)}
                  onLocateMessage={async (target) => {
                    await locate(target);
                    setPreview(false);
                  }}
                />
              </div>
            ) : null}
            <output hidden data-locate-count={count} data-located={located} />
          </main>
        </ReplyJumpContext.Provider>
      </ContentSelectionProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
