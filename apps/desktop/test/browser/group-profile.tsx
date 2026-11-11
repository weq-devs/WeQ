import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupInfoDetailDialog } from '../../src/renderer/src/components/GroupInfoDetailDialog';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { GroupConversationView } from '../../src/renderer/src/im-template/template/conversationDetailsTypes';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
const qa = { mode: 'ready', refreshes: 0, setMode: (_mode: string) => {}, theme: useThemeStore };
Object.assign(window, { groupProfileQa: qa });
const conversation = {
  id: '123',
  kind: 'group',
  generated: false,
  members: [],
  group: {
    name: '本地群名保持不变',
    identityLabel: '群号',
    identityValue: '123',
    memberCount: 2871,
    maxMemberCount: 3000,
    description: '合成群资料',
    remark: '本地备注',
    labels: '',
    customLabels: [],
  },
} as unknown as GroupConversationView;
function App() {
  const [, update] = useState(0);
  qa.setMode = (mode) => {
    qa.mode = mode;
    update((n) => n + 1);
  };
  return <GroupInfoDetailDialog conversation={conversation} detail="profile" onClose={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<App />);
