import { Minus, Square, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { SelfProfileAvatar } from '../../components/SelfProfileAvatar';
import { OnlineStatus } from '../../components/OnlineStatus';
import { VipBadge } from '../../components/VipBadge';
import { RestrictedModeIndicator } from '../../components/RestrictedMode';
import '../../styles/self-profile.css';
import '../../styles/titlebar-search.css';
import '../../styles/window-controls.css';
import type { User } from './types';
import { displayUserName } from './user';
import logoUrl from '@resources/brand/logo.png';
import { cn } from './classNames';
import { DesktopOnly } from '../../lib/target';
import { useWindowControls } from '../../hooks/useWindowControls';
import type { ProfileGroup } from '../../lib/profileNavigation';

export function TitleBar({
  user,
  group,
  homeActive = false,
  onGoHome,
  search,
  windowOnly = false,
}: {
  user: User;
  group?: ProfileGroup;
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
          <SelfProfileAvatar key={`${user.id}:${user.identityValue}`} user={user} group={group}>
            <span className="app-title-bar-nick">{displayUserName(user)}</span>
          </SelfProfileAvatar>
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
