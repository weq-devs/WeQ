import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupLabelSources } from '../../src/renderer/src/components/GroupLabelSources';
import { ProfileNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import type { GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/group-card.css';

const group = {
  id: '12345',
  name: '合成群',
  labels: '同学',
  customLabels: ['VOCALOID', '长标签'.repeat(30)],
  customLabelRecords: [
    { content: 'VOCALOID', setterUid: 'u_missing', setTimestamp: '1733662832' },
    { content: '长标签'.repeat(30), setterUid: 'u_local', setTimestamp: '1733662832' },
  ],
} as GroupConversation['group'];
const members = [
  {
    id: 'u_local',
    uid: 'u_local',
    uin: '10003',
    nick: '较长的本地昵称'.repeat(8),
    remark: '',
    card: '',
    avatarUrl: null,
  },
] as GroupConversation['members'];
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ProfileNavigationContext.Provider
      value={(user, _anchor, context) => Object.assign(window, { openedSetter: { user, context } })}
    >
      <style>{`html,body,#root{min-height:100%;margin:0;background:var(--background);color:var(--foreground)}main{padding:24px;max-width:640px}h1{font-size:20px;margin:0 0 24px}.label-row{display:flex;gap:24px;align-items:flex-start}.label-row>span{flex:none;color:var(--weq-fg-secondary)}.weq-group-tags{min-width:0}button.after{margin-top:32px}`}</style>
      <main>
        <h1>群资料</h1>
        <div className="label-row">
          <span>标签</span>
          <GroupLabelSources group={group} members={members} />
        </div>
        <button type="button" className="after">
          后续字段
        </button>
      </main>
    </ProfileNavigationContext.Provider>
  </QueryClientProvider>,
);
