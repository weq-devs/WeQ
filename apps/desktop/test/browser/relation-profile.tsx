import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfileChatShortcutContext } from '../../src/renderer/src/lib/chatNavigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RelationGraphView } from '../../src/renderer/src/components/relationGraph/RelationGraphView';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { RawNode } from '../../src/renderer/src/components/relationGraph/types';
import '../../src/renderer/src/styles/index.css';

Object.assign(window, { relationProfileQa: { theme: useThemeStore } });
function Fixture() {
  const [member, setMember] = useState<{ node: RawNode; anchor: { x: number; y: number } } | null>(
    null,
  );
  return (
    <ProfileChatShortcutContext.Provider
      value={(target) => ({
        landscape: () => {
          setMember(null);
          document.documentElement.dataset.openedProfileChat =
            target.kind === 'direct' ? target.user.id : target.conversation.id;
        },
      })}
    >
      <div style={{ height: '100dvh', display: 'flex' }}>
        <RelationGraphView onOpenMember={(node, anchor) => setMember({ node, anchor })} />
        {member && (
          <MemberProfileCard
            member={{
              id: member.node.uid,
              identityLabel: 'QQ',
              identityValue: member.node.uin,
              username: member.node.nick,
              displayName: member.node.nick,
              avatarUrl: null,
            }}
            anchor={member.anchor}
            onClose={() => setMember(null)}
          />
        )}
      </div>
    </ProfileChatShortcutContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
);
