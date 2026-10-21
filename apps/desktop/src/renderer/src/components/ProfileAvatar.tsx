import { useContext, type ReactNode } from 'react';
import {
  ProfileNavigationContext,
  profileTargetUser,
  type ProfileTarget,
} from '../lib/profileNavigation';
import '../styles/profile-avatar.css';

export function ProfileAvatar({
  target,
  children,
  enabled = true,
}: {
  target?: ProfileTarget;
  children: ReactNode;
  enabled?: boolean;
}) {
  const open = useContext(ProfileNavigationContext);
  const user = target ? profileTargetUser(target) : null;
  if (!enabled || !open || !user) return <>{children}</>;
  const label = `查看 ${user.displayName} 的名片`;
  return (
    <button
      type="button"
      className="weq-profile-avatar-button"
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        open(
          user,
          event.detail === 0
            ? { x: rect.right, y: rect.bottom }
            : { x: event.clientX, y: event.clientY },
          target?.group,
        );
      }}
    >
      {children}
    </button>
  );
}
