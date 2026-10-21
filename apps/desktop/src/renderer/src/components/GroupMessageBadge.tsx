import { useViewState } from '../state/view';
import {
  DEFAULT_GROUP_BADGE_DISPLAY,
  groupBadgeKey,
  useGroupBadgeDisplay,
} from '../state/groupBadge';

export interface GroupBadgeMember {
  role?: string;
  customTitle?: string | null;
  levelName?: string | null;
  memberLevel?: number;
  levelBracket?: number;
}

export function GroupMessageBadge({
  groupId,
  member,
}: {
  groupId: string;
  member: GroupBadgeMember;
}) {
  const uin = useViewState((state) => state.openedUin);
  const key = groupBadgeKey(uin, groupId);
  const display = useGroupBadgeDisplay(
    (state) => (key && state.preferences[key]) || DEFAULT_GROUP_BADGE_DISPLAY,
  );
  const role = member.role === 'owner' || member.role === 'admin' ? member.role : '';
  const title = display.showTitle
    ? role
      ? role === 'owner'
        ? '群主'
        : '管理员'
      : member.customTitle || member.levelName
    : '';
  const level = display.showLevel && member.memberLevel != null ? `Lv${member.memberLevel}` : '';
  if (!title && !level) return null;
  const tone = title && role ? role : member.levelBracket ? `level-${member.levelBracket}` : '';
  return (
    <small className={`member-badge ${tone}`}>{[level, title].filter(Boolean).join(' · ')}</small>
  );
}
