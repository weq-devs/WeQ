import '../styles/group-message-badge.css';

export interface GroupBadgeMember {
  role?: string;
  customTitle?: string | null;
  levelName?: string | null;
  memberLevel?: number;
}

export function GroupMessageBadge({ member }: { member: GroupBadgeMember }) {
  const role = member.role === 'owner' || member.role === 'admin' ? member.role : '';
  const customTitle = member.customTitle?.trim() ?? '';
  const roleTitle = role === 'owner' ? '群主' : role === 'admin' ? '管理员' : '';
  const title = customTitle || roleTitle || member.levelName?.trim() || '';
  const level =
    member.memberLevel !== undefined &&
    Number.isSafeInteger(member.memberLevel) &&
    member.memberLevel >= 0
      ? `Lv${member.memberLevel}`
      : '';
  if (!title && !level) return null;
  const tone = role || (customTitle ? 'custom-title' : 'neutral');
  const text = level && title && level !== title ? `${level} · ${title}` : title || level;
  return (
    <small className={`member-badge ${tone}`} title={text}>
      {text}
    </small>
  );
}
