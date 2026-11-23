import { ProfileChatShortcutContext } from '../lib/chatNavigation';
import { activateProfile } from '../lib/profileClick';
import { useContext, type ReactNode } from 'react';
import {
  ProfileNavigationContext,
  profileTargetUser,
  type ProfileTarget,
} from '../lib/profileNavigation';
import '../styles/profile-avatar.css';
import '../styles/identity-links.css';

export function ProfileAvatar({
  target,
  children,
  enabled = true,
  className,
}: {
  target?: ProfileTarget;
  children: ReactNode;
  enabled?: boolean;
  className?: string;
}) {
  const open = useContext(ProfileNavigationContext);
  const chatShortcut = useContext(ProfileChatShortcutContext);
  const user = target ? profileTargetUser(target) : null;
  if (!enabled || !open || !user)
    return className ? <span className={className}>{children}</span> : children;
  const label = `查看 ${user.displayName} 的名片`;
  return (
    <button
      type="button"
      className={`weq-profile-avatar-button${className ? ` ${className}` : ''}`}
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const anchor =
          event.detail === 0
            ? { x: rect.right, y: rect.bottom }
            : { x: event.clientX, y: event.clientY };
        activateProfile(
          event,
          () => open(user, anchor, target?.group),
          chatShortcut?.({ kind: 'direct', user, pokeGroupCode: target?.group?.code }),
        );
      }}
    >
      {children}
    </button>
  );
}
