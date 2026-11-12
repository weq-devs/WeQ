import { createRoot } from 'react-dom/client';
import { GroupBulletinList } from '../../src/renderer/src/components/GroupBulletinList';
import {
  mergeGroupNotices,
  resolveGroupNoticePublishers,
} from '../../src/renderer/src/lib/groupNotices';
import { ProfileNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles/base.css';
import '../../src/renderer/src/im-template/styles/modals.css';
import '../../src/renderer/src/styles/group-content-management.css';

const entries = resolveGroupNoticePublishers(
  mergeGroupNotices(
    [],
    [
      {
        noticeId: 'synthetic-notice',
        senderId: 10002,
        publishTime: 1792342800,
        text: '版本更新说明&#10;请先完成数据库体检和修复。&#10;感谢&nbsp;@合成成员&nbsp;的贡献！&#10;&lt;b&gt;此处仍是纯文本&lt;/b&gt;',
        images: [],
        readNum: 20,
      },
    ],
  ),
  [{ uid: 'u_peer', uin: '10002', card: '合成发布者', nick: '昵称' }],
  [],
);
createRoot(document.getElementById('root')!).render(
  <ProfileNavigationContext.Provider
    value={(user) => {
      document.body.dataset.openedProfile = user.identityValue;
    }}
  >
    <main
      className="weq-notice-management"
      style={{ maxWidth: 720, margin: '24px auto', padding: 16 }}
    >
      <GroupBulletinList
        entries={
          new URLSearchParams(location.search).has('history')
            ? entries.map((entry) => ({
                ...entry,
                noticeId: undefined,
                date: '',
                readNum: undefined,
              }))
            : entries
        }
        groupCode="123456"
        groupName="合成测试群"
        tools={() => null}
        onContextMenu={() => {}}
      />
    </main>
  </ProfileNavigationContext.Provider>,
);
