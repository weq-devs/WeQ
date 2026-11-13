import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { sharedGroupConversation } from '../../src/renderer/src/components/ark/groupShareCard';
import {
  ContactNoticeDialog,
  GroupNoticeDialog,
} from '../../src/renderer/src/components/ContactNoticeDialogs';
import { RequestActions } from '../../src/renderer/src/components/qq-actions/RequestActions';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type {
  ContactRequest,
  GroupJoinRequest,
} from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
const root = createRoot(document.getElementById('root')!);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const requests: ContactRequest[] = Array.from({ length: 12 }, (_, index) => ({
  id: `synthetic-${index}`,
  user: {
    id: `u_synthetic_${index}`,
    username: 'synthetic',
    identityLabel: 'QQ',
    identityValue: '10001',
    displayName: index % 2 ? '合成长昵称与LongName'.repeat(8) : '合成联系人',
    avatarUrl: null,
  },
  status: 'pending',
  direction: 'incoming',
  createdAt: '2026-11-07T00:00:37+08:00',
  respondedAt: null,
  message: index % 2 ? '合成长留言'.repeat(20) : '合成申请留言',
}));
const groupRequests: GroupJoinRequest[] = requests.map((request, index) => ({
  id: request.id,
  user: request.user,
  createdAt: request.createdAt,
  group: {
    id: '20001',
    conversationId: '20001',
    identityLabel: '群号',
    identityValue: '20001',
    name: '合成群名称'.repeat(8),
    avatarUrl: null,
    announcement: null,
    memberCount: 20,
  },
  action: '申请加入',
  handleState: 'pending',
  respondedAt: index % 3 === 0 ? '2026-11-07T01:02:49+08:00' : null,
  systemRemark: null,
  operator: index % 3 === 0 ? request.user : null,
  message: `问题：合成问题\n答案：${request.message}`,
  isDoubt: index % 2 === 1,
}));
function NoticePanels({ group }: { group: boolean }) {
  const [card, setCard] = useState<{
    code: string;
    name: string;
    anchor: HTMLButtonElement;
  } | null>(null);
  return (
    <>
      {group ? (
        <GroupNoticeDialog
          open
          requests={groupRequests}
          onClose={() => {}}
          onOpenProfile={(user) => {
            document.documentElement.dataset.noticeProfile = user.identityValue;
          }}
          onOpenGroupProfile={(group, anchor) => setCard({ ...group, anchor })}
        />
      ) : (
        <ContactNoticeDialog
          open
          requests={requests}
          onClose={() => {}}
          onOpenProfile={(user) => {
            document.documentElement.dataset.noticeProfile = user.identityValue;
          }}
        />
      )}
      {card && (
        <GroupProfileDialog
          conversation={sharedGroupConversation({ code: card.code, name: card.name, avatar: '' })}
          anchor={card.anchor}
          detailsKnown={false}
          onClose={() => setCard(null)}
        />
      )}
    </>
  );
}
function render(group: boolean, cards: Element[] = []) {
  root.render(
    <QueryClientProvider client={queryClient}>
      <WorkspacePages navigationKey="contacts">
        <style>{`
      html, body, #root { height: 100%; margin: 0; overflow: hidden; }
      .app-shell.notice-qa-shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100%; min-height: 0; }
      .notice-qa-sidebar { padding: 16px; border-right: 1px solid var(--weq-border-subtle); }
      @media (max-width: 600px) {
        .app-shell.notice-qa-shell { grid-template-columns: minmax(0, 1fr); }
        .notice-qa-sidebar { display: none; }
      }
    `}</style>
        <div className="app-shell notice-qa-shell">
          <aside className="notice-qa-sidebar">联系人</aside>
          <WorkspaceContent>
            <NoticePanels group={group} />
          </WorkspaceContent>
          {cards.map((card, index) =>
            createPortal(
              <RequestActions
                operation={{
                  kind: group ? 'group' : 'friend',
                  token: String(index),
                  uid: `u_synthetic_${index}`,
                  uin: '10001',
                  name: '合成联系人',
                  groupId: group ? '20001' : '',
                  groupName: group ? '合成群' : '',
                  message: '合成留言',
                }}
              />,
              card,
              String(index),
            ),
          )}
        </div>
      </WorkspacePages>
    </QueryClientProvider>,
  );
}
Object.assign(window, {
  noticeQa: {
    store: useThemeStore,
    render,
    mountActions(group: boolean) {
      // 离线桩不返回在线申请；在真实卡片里挂载真实审核区，验证它的布局而不发 QQ 请求。
      render(group, [...document.querySelectorAll('.notice-card-request')]);
    },
  },
});
