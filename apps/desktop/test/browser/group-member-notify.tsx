import { createRoot } from 'react-dom/client';
import { GroupMemberNotifyControl } from '../../src/renderer/src/components/GroupMemberNotifyControl';
import { AvatarContextMenu } from '../../src/renderer/src/im-template/template/avatarContextMenu';
import { useViewState } from '../../src/renderer/src/state/view';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { qa } from './group-member-notify.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { memberNotifyQa: { ...qa, theme: useThemeStore } });
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 18, maxWidth: 480 }}>
    <div className="weq-profile-list">
      <GroupMemberNotifyControl groupId={123} uid="u_peer" memberUin="456" />
    </div>
    <AvatarContextMenu
      state={{
        sender: {
          id: 'u_peer',
          displayName: '合成成员',
          username: '合成成员',
          identityLabel: 'QQ',
          identityValue: '456',
          avatarUrl: null,
        },
        x: 220,
        y: 440,
      }}
      onPoke={() => {}}
      memberNotifyTarget={{ groupId: 123, uid: 'u_peer' }}
    />
  </main>,
);
