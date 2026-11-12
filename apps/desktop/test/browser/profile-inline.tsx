import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ContactIdentity,
  ContactContent,
} from '../../src/renderer/src/components/contactProfile/ContactContent';
import { GroupIdentity } from '../../src/renderer/src/components/groupProfile/GroupContent';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { qa, useFixture } from './contact-card.stub';
import { useSurfaceEscape } from '../../src/renderer/src/lib/surfaceEscape';
import type {
  GroupConversation,
  GroupMemberRole,
} from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-profile.css';
import '../../src/renderer/src/styles/group-card.css';

const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
Object.assign(window, { contactCardQa: qa });
function Fixture() {
  useFixture();
  const card = useRef<HTMLElement>(null);
  const [closed, setClosed] = useState(false);
  useSurfaceEscape(card, () => setClosed(true), !closed, false);
  const person = {
    id: 'u_sample',
    uid: 'u_sample',
    identityLabel: 'QQ',
    identityValue: '10002',
    username: 'sample',
    displayName: '林同学',
    nick: '林同学',
    remark: qa.noRemark ? '' : qa.remark,
    avatarUrl: null,
    isFriend: qa.mode === 'friend',
    categoryName: qa.categoryId === 2 ? '同学' : '朋友',
  };
  const group = new URLSearchParams(location.search).has('group');
  const conversation: GroupConversation = {
    id: '10003',
    type: 'group',
    updatedAt: '',
    otherUser: null,
    members: [],
    unreadCount: 0,
    lastMessage: null,
    preference: { pinned: false, muted: false, archived: false },
    group: {
      id: '10003',
      identityLabel: '群号',
      identityValue: '10003',
      name: qa.groupName,
      remark: qa.groupRemark,
      avatarUrl: null,
      memberCount: 20,
      role: qa.role as GroupMemberRole,
    },
  };
  if (closed) return null;
  return (
    <QueryClientProvider client={cache}>
      <RelationshipDirectoryContext.Provider
        value={{
          selfUid: 'u_self',
          selfUin: qa.account,
          friends: new Map(qa.mode === 'friend' ? [['u_sample', {}]] : []),
          friendsComplete: true,
          groups: new Map([['10003', { listed: qa.inGroup, role: qa.role }]]),
        }}
      >
        <main
          ref={card}
          role="dialog"
          tabIndex={-1}
          className="weq-contact-card weq-member-pop"
          style={{
            position: 'relative',
            margin: '16px auto',
            width: 'min(360px, calc(100vw - 24px))',
          }}
        >
          {group ? (
            <GroupIdentity conversation={conversation} />
          ) : (
            <>
              <ContactIdentity person={person} settings={qa.settings} />
              <ContactContent
                person={person}
                settings={qa.settings}
                fields={['category']}
                preview={false}
              />
            </>
          )}
        </main>
      </RelationshipDirectoryContext.Provider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
