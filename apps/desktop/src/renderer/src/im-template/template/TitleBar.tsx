import { ChevronRight, Minus, Square, X } from 'lucide-react';
import { useContext, useId, useState, type ReactNode } from 'react';
import { Modal } from '../../components/Dialog';
import { SelfQQControls } from '../../components/settings/SelfQQControls';
import { OnlineStatus } from '../../components/OnlineStatus';
import { VipBadge } from '../../components/VipBadge';
import { RestrictedModeIndicator } from '../../components/RestrictedMode';
import '../../styles/self-profile.css';
import '../../styles/titlebar-search.css';
import '../../styles/window-controls.css';
import { Avatar } from './primitives';
import type { User } from './types';
import { displayUserName } from './user';
import logoUrl from '@resources/brand/logo.png';
import { cn } from './classNames';
import { DesktopOnly } from '../../lib/target';
import { useWindowControls } from '../../hooks/useWindowControls';
import { ContactWorkspaceNavigationContext } from '../../lib/profileNavigation';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';

function ProfileAvatar({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="weq-title-profile-avatar"
        aria-label="查看我的名片"
        title="我的名片"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
      </button>
      {open && <SelfProfileDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function SelfProfileDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const navigate = useContext(ContactWorkspaceNavigationContext);
  const session = useQQWriteSession('self-profile-navigation');
  const local = trpc.account.getSelfProfile.useQuery(undefined, {
    enabled: Boolean(session.binding),
    staleTime: 30_000,
  });
  const uin = session.binding?.expectedAccountUin ?? '';
  const profile = local.data?.uin.toString() === uin ? local.data : null;
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      width={560}
      className="weq-self-profile-dialog"
      centered
    >
      <header className="weq-self-profile-header">
        <h2 id={titleId}>我的名片</h2>
        <button
          type="button"
          className="weq-set-iconbtn"
          aria-label="关闭我的名片"
          title="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="weq-self-profile-body">
        <button
          className="weq-self-profile-details-link"
          type="button"
          disabled={!navigate || !uin}
          onClick={() => {
            if (!navigate || !uin) return;
            navigate({
              kind: 'person',
              tab: 'profile',
              contact: {
                id: profile?.uid || uin,
                uid: profile?.uid,
                identityLabel: 'QQ',
                identityValue: uin,
                username: profile?.uid || uin,
                displayName: profile?.nick || uin,
                nick: profile?.nick,
                avatarUrl: profile?.avatarUrl ?? null,
                signature: profile?.signature,
                createdAt: new Date(0).toISOString(),
              },
            });
            onClose();
          }}
        >
          查看资料
          <ChevronRight size={15} />
        </button>
        <SelfQQControls editable={false} />
      </div>
    </Modal>
  );
}

export function TitleBar({
  user,
  homeActive = false,
  onGoHome,
  search,
  windowOnly = false,
}: {
  user: User;
  homeActive?: boolean;
  onGoHome?: () => void;
  search?: ReactNode;
  windowOnly?: boolean;
}) {
  const controls = useWindowControls();
  const handleMinimize = () => {
    window.electron?.ipcRenderer.send('window-minimize');
  };

  const handleMaximize = () => {
    window.electron?.ipcRenderer.send('window-maximize');
  };

  const handleClose = () => {
    window.electron?.ipcRenderer.send('window-close');
  };

  return (
    <div className={cn('app-title-bar', controls === 'native' && 'has-native-controls')}>
      <button
        type="button"
        className={`app-title-bar-logo-wrap${homeActive ? ' is-active' : ''}`}
        title="主页"
        onClick={onGoHome}
      >
        <img src={logoUrl} className="app-title-bar-logo" alt="主页" />
      </button>
      {!windowOnly && (
        <div className="app-title-bar-user">
          <ProfileAvatar key={`${user.id}:${user.identityValue}`} user={user} />
          <span className="app-title-bar-nick">{displayUserName(user)}</span>
          {/* 会员徽标：独立兄弟节点，不嵌进昵称 —— 那个 span 自带 ellipsis 会把它裁掉。 */}
          <VipBadge key={user.identityValue} />
          {user.uid && (
            <OnlineStatus
              key={user.uid}
              uid={user.uid}
              className="weq-title-online-status"
              refetchInterval={15_000}
            />
          )}
          {user.signature && (
            <span className="app-title-bar-signature" title={user.signature}>
              {user.signature}
            </span>
          )}
        </div>
      )}
      <div className="app-title-bar-drag" />
      {!windowOnly && search}
      <div className="weq-titlebar-restriction">
        <div>
          <RestrictedModeIndicator persistent />
        </div>
      </div>
      <DesktopOnly>
        {controls === 'windows' && (
          <div className="app-title-bar-actions">
            <button onClick={handleMinimize} title="最小化">
              <Minus size={14} />
            </button>
            <button onClick={handleMaximize} title="最大化/还原">
              <Square size={12} />
            </button>
            <button onClick={handleClose} className="close" title="关闭">
              <X size={16} />
            </button>
          </div>
        )}
      </DesktopOnly>
    </div>
  );
}
