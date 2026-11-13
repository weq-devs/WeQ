import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SearchDropdown } from '../../src/renderer/src/components/search/SearchDropdown';
import {
  DEFAULT_SEARCH_CATEGORIES,
  DEFAULT_SEARCH_SOURCES,
  type SearchSource,
} from '@weq/service/search-policy';
import type { SearchCategory } from '../../src/renderer/src/components/search/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/workspace-tools.css';

function SearchFixture() {
  const [sources, setSources] = useState<SearchSource[]>([...DEFAULT_SEARCH_SOURCES]);
  const [categories, setCategories] = useState<SearchCategory[]>([...DEFAULT_SEARCH_CATEGORIES]);
  return (
    <main
      className="weq-titlebar-search-results"
      style={{ position: 'static', width: 'min(720px, 100%)', maxHeight: '100%', margin: '0 auto' }}
    >
      <SearchDropdown
        keyword="设置"
        sources={sources}
        onSourcesChange={setSources}
        categories={categories}
        onCategoriesChange={setCategories}
        onSelectAppEntry={() => {}}
        onSelect={() => {}}
        onMore={() => {}}
        quick={{
          contacts: [
            {
              category: 'contact',
              uid: 'synthetic-person',
              uin: '',
              nick: '设置讨论与项目记录',
              remark: '',
              avatarUrl: null,
              isFriend: true,
              hasConversation: true,
              temporary: false,
              aliases: [],
              groups: [],
            },
          ],
          conversations: [],
          friends: [],
          groupMembers: [],
        }}
        quickLoading={false}
        slow={{
          chatRecords: [],
          files: [],
          collections: [],
          cloneMessages: [],
          assistantMessages: [],
          messageHits: [
            {
              category: 'assistantMessage',
              kind: 'assistant',
              ownerId: 'assistant',
              sessionId: 'synthetic-task',
              messageId: '',
              title: 'WeQ 助手',
              sessionTitle: '设置迁移与会话资料核对',
              content: '设置迁移与会话资料核对',
              ts: 1,
              matchType: 'title',
            },
          ],
          indexStatus: 'disabled',
        }}
        slowLoading={false}
      />
    </main>
  );
}

document.body.style.cssText =
  'margin:0;padding:12px;box-sizing:border-box;height:100dvh;background:var(--weq-bg-surface);color:var(--weq-fg-primary);font-family:system-ui;';
createRoot(document.getElementById('root')!).render(<SearchFixture />);
