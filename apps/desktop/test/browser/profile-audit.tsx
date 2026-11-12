import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { ContactCardSettings } from '../../src/renderer/src/components/settings/ContactCardSettings';
import {
  ContactWorkspaceNavigationContext,
  type ContactWorkspaceTab,
} from '../../src/renderer/src/lib/profileNavigation';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { ChatNavigationContext } from '../../src/renderer/src/lib/chatNavigation';
import { QzoneNavigationContext } from '../../src/renderer/src/lib/qzoneNavigation';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { useViewState } from '../../src/renderer/src/state/view';
import type { Contact } from '../../src/renderer/src/im-template/template/types';
import { qa, useFixture } from './contact-card.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-profile.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'card';
const state = params.get('state') ?? 'default';

const rich: Contact = {
  id: 'u_sample',
  uid: 'u_sample',
  identityLabel: 'QQ',
  identityValue: '10002',
  username: 'u_sample',
  displayName: '林同学',
  nick: '林同学',
  remark: '小林',
  avatarUrl: '/resources/qqlevel/penguin.png',
  createdAt: '',
  isFriend: true,
  friendshipKnown: true,
  signature: '认真记录每一天的小事。\n第二行原文。\n第三行原文。\n第四行原文。',
  gender: 2,
  age: 23,
  birthYear: 2003,
  birthMonth: 5,
  birthDay: 12,
  qid: 'sample-person',
  categoryName: '朋友',
  customStatus: '正在听音乐',
  extInfo: {
    interests: ['本地标签'],
    school: '示例大学',
    degree: '本科',
    country: '中国',
    province: '福建',
    city: '厦门',
    privileges: [],
    interactMarks: [],
    album: [],
  },
  profileContext: {
    groupCode: '10003',
    groupName: '合成群',
    member: {
      card: '群内小林',
      role: 'member',
      customTitle: '',
      memberLevel: 8,
      levelName: '活跃成员',
      joinedAt: '2024-09-01T00:00:00+08:00',
    },
  },
};

/** 长文本：超长昵称、四行签名、超长群名与地区，用来压数据行换行与对齐。 */
const long: Contact = {
  ...rich,
  displayName: '一个特别特别长的联系人昵称用来测试换行与省略号行为是否正确',
  remark: '这是一个非常长的备注名称也会撑开身份区',
  signature:
    '第一步：先写一句很长的个性签名，用来观察三行截断是否生效，以及展开后按钮是否还在可视区域内。\n第二步：继续加第二行，看看行高与字重是不是和小标题打架。\n第三步：第三行继续填充内容，确认拖动选择文本时不会误触发跳转。\n第四步：第四行默认应当被截断。',
  qid: 'a-very-long-qid-value-for-testing',
  extInfo: {
    ...rich.extInfo,
    school: '一所名字特别长的大学附属联合国际学院',
    degree: '硕士研究生',
    province: '福建省很长的省名',
    city: '厦门市思明区很长的城市名',
  },
  profileContext: {
    groupCode: '10003',
    groupName: '一个名字特别长的群聊用来测试群上下文标题换行',
    member: {
      card: '群名片也非常非常长的群内小林同学',
      role: 'admin',
      customTitle: '一个很长的专属头衔',
      memberLevel: 8,
      levelName: '活跃成员',
      joinedAt: '2024-09-01T00:00:00+08:00',
    },
  },
};

/** 空数据：没有签名、没有扩展资料、没有群上下文，验证空态与行隐藏。 */
const empty: Contact = {
  id: 'u_blank',
  uid: 'u_blank',
  identityLabel: 'QQ',
  identityValue: '10009',
  username: 'u_blank',
  displayName: '空资料联系人',
  nick: '',
  avatarUrl: null,
  createdAt: '',
  isFriend: false,
  friendshipKnown: true,
};

const sample = state === 'long' ? long : state === 'empty' ? empty : rich;

const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
Object.assign(window, { profileAuditQa: qa });
function Fixture() {
  useFixture();
  useEffect(() => {
    useViewState.setState({ openedUin: qa.account });
  }, [qa.account]);
  const [page, setPage] = useState(view === 'closed' ? 'closed' : view);
  const [person, setPerson] = useState(sample);
  const [tab, setTab] = useState<ContactWorkspaceTab>(
    (params.get('tab') as ContactWorkspaceTab) ?? 'profile',
  );
  const target: Contact =
    state === 'self'
      ? {
          ...person,
          id: 'self:10001',
          uid: 'u_self',
          identityValue: qa.account,
          displayName: '我',
          nick: '我',
          remark: undefined,
        }
      : {
          ...person,
          kind: qa.mode === 'bot' ? 'bot' : 'human',
          isFriend: qa.mode !== 'nonfriend',
          extInfo: person.extInfo
            ? { ...person.extInfo, isEnterprise: qa.mode === 'enterprise' }
            : undefined,
        };
  return (
    <QueryClientProvider client={cache}>
      <RelationshipDirectoryContext.Provider
        value={{
          selfUin: qa.account,
          selfUid: 'u_self',
          friends: new Map([[target.id, {}]]),
          friendsComplete: true,
          groups: new Map([['10003', { listed: true, role: 'owner' }]]),
        }}
      >
        <ConversationDirectoryContext.Provider
          value={{
            real: [],
            virtual: [],
            onVirtual: () => {},
            onCreate: () => {},
            profileConversationExists: () => true,
          }}
        >
          <ChatNavigationContext.Provider value={() => {}}>
            <QzoneNavigationContext.Provider value={() => {}}>
              <ContactWorkspaceNavigationContext.Provider
                value={(next) => {
                  if (next.kind === 'person') {
                    setPerson(next.contact);
                    setTab(next.tab ?? 'profile');
                    setPage('page');
                  }
                }}
              >
                <style>{`html,body,#root{height:100%;margin:0}.audit-fixture{height:100%;max-width:1120px;margin:auto;background:var(--weq-bg-surface);color:var(--weq-fg-primary);display:flex;flex-direction:column}.audit-tools{display:flex;gap:12px;padding:8px;flex-shrink:0}.audit-tools button{border:1px solid var(--weq-border-subtle);border-radius:4px;padding:4px 8px}.audit-body{min-height:0;flex:1;overflow:auto}.audit-fixture .weq-settings-dialog{position:static;display:block;width:auto;height:auto;max-height:none;min-width:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}.audit-fixture .weq-settings-body{display:block;height:auto;overflow:visible}`}</style>
                <main className="audit-fixture">
                  <nav className="audit-tools">
                    <button type="button" onClick={() => setPage('card')}>
                      打开名片
                    </button>
                    <button type="button" onClick={() => setPage('page')}>
                      资料页
                    </button>
                    <button type="button" onClick={() => setPage('settings')}>
                      名片设置
                    </button>
                    <span id="audit-view">{page}</span>
                  </nav>
                  <div className="audit-body">
                    {page === 'card' ? (
                      <MemberProfileCard
                        member={target}
                        anchor={{ x: 16, y: 58 }}
                        groupCode={target.profileContext?.groupCode}
                        groupName={target.profileContext?.groupName}
                        onClose={() => setPage('closed')}
                        onOpenChat={() => {}}
                        onPreviewChat={() => {}}
                      />
                    ) : page === 'page' ? (
                      <ContactProfileDialog
                        contact={target}
                        embedded={params.get('embedded') !== '0'}
                        tab={tab}
                        onTabChange={setTab}
                        onClose={() => setPage('closed')}
                      />
                    ) : page === 'settings' ? (
                      <div className="weq-settings-dialog">
                        <div className="weq-settings-body">
                          <ContactCardSettings />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </main>
              </ContactWorkspaceNavigationContext.Provider>
            </QzoneNavigationContext.Provider>
          </ChatNavigationContext.Provider>
        </ConversationDirectoryContext.Provider>
      </RelationshipDirectoryContext.Provider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
