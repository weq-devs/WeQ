import { useState } from 'react';
import { createRoot } from 'react-dom/client';
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
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
