import { activateProfile } from '../lib/profileClick';
import { useContext, type ReactNode } from 'react';
import { Avatar } from '../im-template/template/primitives';
import type { User } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { ProfileNavigationContext, type ProfileGroup } from '../lib/profileNavigation';
import '../styles/identity-links.css';

export function SelfProfileAvatar({
  user,
  group,
  className = 'weq-title-profile-avatar',
  children,
}: {
  user: User;
  group?: ProfileGroup;
  className?: string;
  children?: ReactNode;
}) {
  const open = useContext(ProfileNavigationContext);
  return (
    <button
      type="button"
      className={`${className}${children ? ' weq-self-identity-link' : ''}`}
      aria-label="查看我的名片"
      title="我的名片"
      aria-haspopup="dialog"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const anchor =
          event.detail === 0
            ? { x: rect.right, y: rect.bottom, trigger: event.currentTarget }
            : { x: event.clientX, y: event.clientY, trigger: event.currentTarget };
        activateProfile(event, () => open?.(user, anchor, group));
      }}
    >
      <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
      {children}
    </button>
  );
}
