import { createRoot } from 'react-dom/client';
import {
  ContactList,
  GroupList,
} from '../../src/renderer/src/im-template/template/conversationLists';
import { ContactRefreshButton } from '../../src/renderer/src/components/ContactRefreshButton';
import { BackgroundTaskDetails } from '../../src/renderer/src/components/tasks/BackgroundTaskDetails';
import { ContactDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { useViewState } from '../../src/renderer/src/state/view';
import { useWorkspaceMenu } from '../../src/renderer/src/state/workspaceMenu';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { Contact, GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
Object.assign(window, { contactOrderQa: { store: useThemeStore, tasks: useWorkspaceMenu } });
const contacts: Contact[] = ['阿明', '白雪', '张同学'].map((name, i) => ({
  id: `u_friend${i}`,
  username: name,
  displayName: name,
  nick: i === 0 ? '小明' : name,
  remark: i === 0 ? name : undefined,
  signature: `合成签名 ${i + 1}`,
  intimacy: 30 + i,
  identityLabel: 'QQ',
  identityValue: String(10001 + i),
  avatarUrl: null,
  createdAt: '',
  age: 20 + i,
  birthYear: 2005 + i,
  birthMonth: i + 1,
  birthDay: 15,
  categoryId: 0,
  extRelation: i === 1 ? { displayId: 26, preselectedIds: [] } : undefined,
  extInfo: {
    country: i === 2 ? '2' : '1',
    province: '35',
    city: '',
    interests: [],
    album: [],
    interactMarks: [],
    privileges: [],
  },
}));
const groups: GroupConversation[] = [200, 500, 500].map((capacity, i) => ({
  id: String(20001 + i),
  type: 'group',
  updatedAt: '',
  lastMessage: null,
  otherUser: null,
  members: [],
  group: {
    id: String(20001 + i),
    name: ['学习交流', '朋友们', '长名称群聊用于检查窄屏显示'][i]!,
    remark: i === 0 ? '自习组' : undefined,
    createTime: '2018-06-11T16:30:00Z',
    identityLabel: '群',
    identityValue: String(20001 + i),
    avatarUrl: null,
    memberCount: i + 3,
    maxMemberCount: capacity,
    role: 'member',
    roleKnown: true,
    listed: true,
    membershipKnown: true,
  },
}));
const relationships = {
  selfUid: 'u_self',
  selfUin: '99999',
  friends: new Map(contacts.map((contact) => [contact.id, { categoryName: '我的好友' }])),
  friendsComplete: true,
  groups: new Map(groups.map((group) => [group.id, { listed: true, role: 'member' as const }])),
};
createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <RelationshipDirectoryContext.Provider value={relationships}>
      <style>{`html,body,#root{min-height:100%;height:auto;margin:0;overflow:auto}.order-fixture{padding:16px;background:var(--weq-chat-bg);color:var(--weq-fg-primary);min-height:100vh}.order-fixture-columns{display:grid;grid-template-columns:repeat(2,minmax(0,350px));gap:20px}.order-fixture section{min-width:0}.order-fixture h2{font-size:16px;margin:12px}.order-fixture .weq-contact-directory{height:540px}.order-fixture [data-refresh]{margin:12px}@media(max-width:700px){.order-fixture-columns{grid-template-columns:minmax(0,1fr)}.order-fixture{padding:4px}}`}</style>
      <main className="order-fixture">
        <div data-refresh>
          <ContactRefreshButton onRefresh={() => {}} />
        </div>
        <div className="order-fixture-columns">
          <section data-kind="friends">
            <h2>好友</h2>
            <ContactDirectoryContext.Provider
              value={{ query: '', onQuery: () => {}, ids: contacts.map((contact) => contact.id) }}
            >
              <ContactList
                contacts={contacts}
                specialSections={[
                  { id: 'special:care', name: '特别关心', items: [contacts[0]!] },
                  { id: 'special:intimate', name: '亲密关系', items: [contacts[1]!] },
                ]}
                activeContactId={null}
                onSelect={() => {}}
              />
            </ContactDirectoryContext.Provider>
          </section>
          <section data-kind="groups">
            <h2>群聊</h2>
            <GroupList conversations={groups} activeConversationId={null} onSelect={() => {}} />
          </section>
        </div>
        <section data-kind="tasks">
          <h2>好友/群信息缓存任务</h2>
          <BackgroundTaskDetails
            scope={{ uin: '99999', configId: 'contact-order-fixture' }}
            refresh={async () => {}}
            entry={{
              source: 'window',
              task: {
                id: 'synthetic-task',
                kind: 'contacts',
                name: '更新好友/群信息缓存',
                status: 'running',
                progress: 50,
                startedAt: 1,
                updatedAt: 2,
                actions: [],
                subtasks: [
                  { label: '好友', done: 1, total: 3, failed: 0 },
                  { label: '群聊', done: 2, total: 3, failed: 0 },
                ],
                details: [
                  '好友获取结果：' +
                    JSON.stringify({
                      QQ号: '10001',
                      昵称: '阿明',
                      年龄: 20,
                      指标: {
                        'QQ 等级': { 值: 10, 状态: '获取成功' },
                        共同好友数: { 值: 0, 状态: '获取成功' },
                      },
                    }),
                  '群聊获取结果：' +
                    JSON.stringify({
                      群号: '20001',
                      群名: '学习交流',
                      人数: 3,
                      群容量: 200,
                      指标: { 群内好友数: { 值: 2, 状态: '获取成功' } },
                    }),
                  '过程日志：' +
                    JSON.stringify({
                      ts: 1700000000000,
                      seq: 1,
                      stage: 'friends',
                      level: 'info',
                      text: '开始：好友 阿明（10001）',
                    }),
                  '过程日志：' +
                    JSON.stringify({
                      ts: 1700000001000,
                      seq: 2,
                      stage: 'groups',
                      level: 'info',
                      text: '完成：群 学习交流（20001）',
                    }),
                ],
              },
            }}
          />
        </section>
      </main>
    </RelationshipDirectoryContext.Provider>
  </ContentSelectionProvider>,
);
