import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TitleBarSearch } from '../../src/renderer/src/components/TitleBarSearch';
import { SearchResultsPanel } from '../../src/renderer/src/components/search/SearchResultsPanel';
import { useSearchReturn } from '../../src/renderer/src/hooks/useSearchReturn';
import type { SearchCategory } from '../../src/renderer/src/components/search/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/workspace-tools.css';

function Fixture() {
  const [query, setQuery] = useState('资料');
  const [categories, setCategories] = useState<SearchCategory[]>(['contact', 'chatRecord']);
  const navigation = useSearchReturn('synthetic', query, categories);
  return (
    <TitleBarSearch
      query={query}
      onQueryChange={(value) => {
        navigation.clear();
        setQuery(value);
      }}
      results={
        <SearchResultsPanel
          navigation={navigation}
          onJumpMessage={() => {}}
          renderDetail={() => null}
          keyword={query}
          categories={categories}
          onCategoriesChange={setCategories}
          quick={{
            contacts: Array.from({ length: 3 }, (_, index) => ({
              category: 'contact',
              uid: `person-${index}`,
              uin: '',
              nick: `资料 ${index}`,
              remark: '',
              avatarUrl: null,
              isFriend: true,
              hasConversation: true,
              temporary: false,
              aliases: [],
              groups: [],
            })),
            conversations: [],
            friends: [],
            groupMembers: [],
          }}
          quickLoading={false}
          slow={{
            chatRecords: Array.from({ length: 3 }, (_, index) => ({
              category: 'chatRecord',
              source: 'group',
              partition: `group-${index}`,
              targetUid: `group-${index}`,
              targetUin: '',
              name: '用于核验窄屏布局及逐级返回的项目讨论与资料记录群',
              count: 5,
              matchedBulletins: index === 2 ? 2 : undefined,
            })),
            messageCoverage: {
              scope: 'observed-cache',
              records: 375,
              limited: false,
              updatedAt: 1,
            },
            files: [],
            collections: [],
            cloneMessages: [],
            assistantMessages: [],
            indexStatus: 'disabled',
          }}
          slowLoading={false}
          onSelect={(hit) => {
            if (hit.category === 'group') document.body.dataset.openedGroup = hit.groupCode;
          }}
        />
      }
    />
  );
}

document.body.style.cssText =
  'margin:0;padding:16px;box-sizing:border-box;height:100dvh;background:var(--weq-bg-surface);color:var(--weq-fg-primary);font-family:system-ui;';
createRoot(document.getElementById('root')!).render(<Fixture />);
