import { createRoot } from 'react-dom/client';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { MergedSessionPanel } from '../../src/renderer/src/components/sidebar/MergedSessionPanel';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
const seed = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
const conversations = ['10001', '10002', '10003'].map((id, index) => ({
  ...seed,
  id,
  group: { ...seed.group, id, name: `合成测试群 ${index + 1}` },
  updatedAt: `2030-01-0${3 - index}T00:00:00Z`,
  lastMessage: null,
  unreadCount: index,
  preference: { pinned: index !== 1, muted: false, blocked: false },
}));

const root = createRoot(document.getElementById('root')!);
function render(rows = conversations) {
  root.render(
    <ContentSelectionProvider>
      <style>{`
      html,body,#root{height:100%;margin:0}
      .states-fixture{height:100%;background:var(--weq-bg-surface)}
      .states-fixture .app-shell{display:block;width:340px;min-width:0;height:100%}
      .states-fixture .weq-conversation-directory{height:100%}
      @media(max-width:600px){.states-fixture .app-shell{width:100%}}
    `}</style>
      <div className="states-fixture app-shell-root weq-web-shell">
        <div className="app-shell">
          <ConversationList
            conversations={rows}
            activeConversationId="10001"
            preferences={{}}
            drafts={{}}
            onSelect={() => {}}
          />
        </div>
        <MergedSessionPanel
          kind="groupAssistant"
          conversations={conversations}
          groupAssistantIds={new Set(conversations.map((row) => row.id))}
          anchorX={360}
          anchorY={250}
          onBack={() => {}}
          onSelectConversation={() => {}}
        />
      </div>
    </ContentSelectionProvider>,
  );
}
Object.assign(window, {
  conversationStatesQa: {
    store: useThemeStore,
    promote: () =>
      render(
        conversations.map((row) =>
          row.id === '10002'
            ? {
                ...row,
                updatedAt: '2030-01-04T00:00:00Z',
                preference: { ...row.preference, pinned: true },
              }
            : row,
        ),
      ),
    removeFirst: () => render(conversations.filter(({ id }) => id !== '10001')),
    reset: () => render(),
    distantOrder: (pinned: boolean) =>
      render([
        {
          ...conversations[0]!,
          updatedAt: '2029-12-31T00:00:00Z',
          preference: { pinned, muted: false, blocked: false },
        },
        ...Array.from({ length: 6 }, (_, index) => {
          const row = conversations[1]!;
          const id = String(20001 + index);
          return {
            ...row,
            id,
            group: { ...row.group, id },
            updatedAt: `2030-01-0${6 - index}T00:00:00Z`,
          };
        }),
      ]),
  },
});
render();
