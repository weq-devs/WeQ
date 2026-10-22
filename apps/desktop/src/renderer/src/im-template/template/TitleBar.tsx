import { Minus, Square, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Modal } from '../../components/Dialog';
import { SelfQQControls } from '../../components/settings/SelfQQControls';
import { OnlineStatus } from '../../components/OnlineStatus';
import { RestrictedModeIndicator } from '../../components/RestrictedMode';
import '../../styles/self-profile.css';
import { Avatar } from './primitives';
import type { User } from './types';
import { displayUserName } from './user';
import logoUrl from '@resources/brand/logo.png';
import { cn } from './classNames';
import { DesktopOnly, IS_MAC } from '../../lib/target';

function ProfileAvatar({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <>
      <button
        type="button"
        className="weq-title-profile-avatar"
        aria-label="编辑 QQ 资料"
        title="编辑 QQ 资料"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
      </button>
      {open && (
        <Modal
          onClose={() => setOpen(false)}
          labelledBy={titleId}
          width={560}
          className="weq-self-profile-dialog"
          centered
        >
          <header className="weq-self-profile-header">
            <h2 id={titleId}>QQ 资料与状态</h2>
            <button
              type="button"
              className="weq-set-iconbtn"
              aria-label="关闭资料编辑"
              title="关闭"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </header>
          <div className="weq-self-profile-body">
            <SelfQQControls />
          </div>
        </Modal>
      )}
    </>
  );
}

export function TitleBar({
  user,
  homeActive = false,
  onGoHome,
  search,
}: {
  user: User;
  homeActive?: boolean;
  onGoHome?: () => void;
  search?: ReactNode;
}) {
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
    <div className={cn('app-title-bar', IS_MAC && 'is-mac')}>
      <button
        type="button"
        className={`app-title-bar-logo-wrap${homeActive ? ' is-active' : ''}`}
        title="主页"
        onClick={onGoHome}
      >
        <img src={logoUrl} className="app-title-bar-logo" alt="主页" />
      </button>
      {search}
      <div className="app-title-bar-user">
        <ProfileAvatar key={`${user.id}:${user.identityValue}`} user={user} />
        <span className="app-title-bar-nick">{displayUserName(user)}</span>
        {user.uid && (
          <OnlineStatus
            key={user.uid}
            uid={user.uid}
            className="weq-title-online-status"
            refetchInterval={15_000}
          />
        )}
        {user.signature && <span className="app-title-bar-signature">{user.signature}</span>}
      </div>
      <div className="app-title-bar-drag" />
      <RestrictedModeIndicator />
      {/* macOS 有原生红黄绿三键，自绘的 最小化/最大化/关闭 会重复，隐藏掉。 */}
      {!IS_MAC && (
        <DesktopOnly>
          <div className="app-title-bar-actions">
            <button onClick={handleMinimize} title="最小化">
              <Minus size={14} />
            </button>
            <button onClick={handleMaximize} title="全屏/还原">
              <Square size={12} />
            </button>
            <button onClick={handleClose} className="close" title="关闭">
              <X size={16} />
            </button>
          </div>
        </DesktopOnly>
      )}
    </div>
  );
}
