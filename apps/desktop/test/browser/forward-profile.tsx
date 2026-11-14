import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ForwardWindowHost,
  openForwardWindow,
} from '../../src/renderer/src/components/ForwardWindow';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import {
  ProfileNavigationContext,
  type ProfileGroup,
} from '../../src/renderer/src/lib/profileNavigation';
import type { User } from '../../src/renderer/src/im-template/template/types';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { forwardProfileQa: useThemeStore });
const text = [{ type: 'text', data: { textContent: '合成消息正文' } }];
const name = new URLSearchParams(location.search).has('long')
  ? '这是一个用于核对窄屏换行和头像时间对齐的很长很长的好友昵称'
  : '本地备注';
function Fixture() {
  const [card, setCard] = useState<{
    user: User;
    anchor: { x: number; y: number };
    group?: ProfileGroup;
  } | null>(null);
  useEffect(() => {
    openForwardWindow({
      title: '合并聊天记录',
      kind: 'c2c',
      conv: '',
      msgId: '1',
      records: [
        {
          msgId: '2',
          senderUid: 'u_sample',
          senderUin: '10002',
          sendNick: name,
          sendTime: '1700000000',
          elements: text,
        },
        { msgId: '3', senderUin: '10002', sendNick: '只有 QQ 号的好友', elements: text },
        {
          msgId: '4',
          senderUid: 'u_sample',
          senderUin: '10002',
          sendNick: '本地备注',
          elements: [{ type: 'multiMsg', data: { _label: '嵌套聊天记录' } }],
          subMsgs: [
            {
              msgId: '5',
              senderUid: 'u_sample',
              senderUin: '10002',
              sendNick: '嵌套好友',
              sendTime: '1700000000',
              elements: text,
            },
          ],
        },
        { msgId: '6', sendNick: '匿名记录', elements: text },
      ],
    });
  }, []);
  return (
    <ProfileNavigationContext.Provider
      value={(user, anchor, group) => setCard({ user, anchor, group })}
    >
      <ForwardWindowHost />
      {card ? (
        <MemberProfileCard
          member={card.user}
          anchor={card.anchor}
          groupCode={card.group?.code}
          groupName={card.group?.name}
          onClose={() => setCard(null)}
        />
      ) : null}
    </ProfileNavigationContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
);
