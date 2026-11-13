import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GiftWall } from '../../src/renderer/src/components/gift/GiftWall';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { ProfileNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import type { User } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

const friend = { id: 'u_peer', identityLabel: 'QQ', identityValue: '10002', nick: '合成联系人' };
const directory = {
  selfUin: '10001',
  selfUid: 'u_self',
  friends: new Map([
    ['u_peer', friend],
    ['10002', friend],
  ]),
  friendsComplete: true,
  groups: new Map(),
};
function Fixture() {
  const [card, setCard] = useState<{ member: User; anchor: { x: number; y: number } } | null>(null);
  return (
    <ProfileNavigationContext.Provider value={(member, anchor) => setCard({ member, anchor })}>
      <main style={{ padding: 16, maxWidth: 1180, margin: '0 auto' }}>
        <GiftWall />
      </main>
      {card ? (
        <MemberProfileCard
          member={card.member}
          anchor={card.anchor}
          onClose={() => setCard(null)}
        />
      ) : null}
    </ProfileNavigationContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RelationshipDirectoryContext.Provider value={directory}>
      <style>
        {'html,body,#root{min-height:100%;margin:0}body{background:var(--weq-bg-surface)}'}
      </style>
      <Fixture />
    </RelationshipDirectoryContext.Provider>
  </QueryClientProvider>,
);
