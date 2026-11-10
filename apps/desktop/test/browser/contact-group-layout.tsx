import { createRoot } from 'react-dom/client';
import { GroupProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { GroupInfoPanel } from '../../src/renderer/src/im-template/template/groupInfoPanel';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
const qa = { store: useThemeStore, closeCount: 0 };
Object.assign(window, { groupLayoutQa: qa });
const noop = () => {};
const group: GroupConversation = {
  id: '20001',
  type: 'group',
  updatedAt: new Date(0).toISOString(),
  lastMessage: null,
  otherUser: null,
  members: Array.from({ length: 60 }, (_, index) => ({
    id: `u_member_${index}`,
    uin: String(10000 + index),
    identityLabel: 'QQ',
    identityValue: String(10000 + index),
    username: `member_${index}`,
    displayName: `合成群成员 ${index + 1}`,
    avatarUrl: null,
    createdAt: new Date(0).toISOString(),
  })),
  group: {
    id: '20001',
    identityLabel: '群号',
    identityValue: '20001',
    name: '合成群资料布局检查',
    avatarUrl: null,
    announcement: '合成公告：这是完整群资料的布局回归样本。\n'.repeat(12),
    memberCount: 60,
    description: '合成群简介：用于检查长段落能否完整换行显示。'.repeat(10),
    remark: 'long-unbroken-group-remark-'.repeat(14),
    createTime: 1700000000000,
    maxMemberCount: 200,
    role: 'member',
    roleKnown: true,
  },
};
const sparse = new URLSearchParams(location.search).has('sparse');

createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{height:100%;margin:0;overflow:hidden}
      .group-layout-fixture{height:100%;max-width:1180px;margin:auto}
    `}</style>
    <main className="group-layout-fixture">
      <GroupProfileDialog
        conversation={group}
        embedded
        onClose={() => qa.closeCount++}
        details={
          <GroupInfoPanel
            layout="profile"
            conversation={group}
            onOpenDetail={noop}
            onOpenAnnouncements={sparse ? undefined : noop}
            onOpenEssence={sparse ? undefined : noop}
            onOpenAlbums={sparse ? undefined : noop}
            onOpenFiles={sparse ? undefined : noop}
          />
        }
      />
    </main>
  </>,
);
