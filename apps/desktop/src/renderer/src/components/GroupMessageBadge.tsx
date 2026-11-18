import '../styles/group-message-badge.css';
import { NumericText } from './NumericText';

export interface GroupBadgeMember {
  role?: string;
  customTitle?: string | null;
  levelName?: string | null;
  memberLevel?: number;
}

export function GroupMessageBadge({
  member,
  showLevel = true,
  showTitle = true,
}: {
  member: GroupBadgeMember;
  showLevel?: boolean;
  showTitle?: boolean;
}) {
  const role = member.role === 'owner' || member.role === 'admin' ? member.role : '';
  const customTitle = member.customTitle?.trim() ?? '';
  const roleTitle = role === 'owner' ? '群主' : role === 'admin' ? '管理员' : '';
  const title =
    (showTitle ? customTitle || roleTitle : '') ||
    (showLevel ? member.levelName?.trim() : '') ||
    '';
  const level =
    showLevel &&
    member.memberLevel !== undefined &&
    Number.isSafeInteger(member.memberLevel) &&
    member.memberLevel >= 0
      ? `Lv${member.memberLevel}`
      : '';
  if (!title && !level) return null;
  const tone = (showTitle && (role || (customTitle ? 'custom-title' : ''))) || 'neutral';
  const text = level && title && level !== title ? `${level} · ${title}` : title || level;
  return (
    <small
      className={`member-badge ${tone}`}
      title={text}
      data-privacy-title={(showTitle && Boolean(customTitle)) || undefined}
    >
      {level ? <NumericText>{level}</NumericText> : null}
      {title && title !== level ? (
        <>
          {level ? ' · ' : null}
          <span data-privacy-sensitive={(showTitle && Boolean(customTitle)) || undefined}>
            {title}
          </span>
        </>
      ) : null}
    </small>
  );
}
