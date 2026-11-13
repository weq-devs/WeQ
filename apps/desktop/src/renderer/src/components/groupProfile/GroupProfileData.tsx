import type { useGroupProfile } from '../../hooks/useGroupProfile';
import { ContactInlineError, ContactRow, ContactSection } from '../contactProfile/ContactRow';
import { GroupCardContent } from './GroupCardContent';
import type { GroupMember } from '../../im-template/template/types';

export function GroupProfileData({
  data,
  onOpenMembers,
  onOpenMember,
}: {
  data: ReturnType<typeof useGroupProfile>;
  onOpenMembers: () => void;
  onOpenMember: (member: GroupMember, anchor: { x: number; y: number }) => void;
}) {
  const profile = data.extended?.profile;
  const activity = data.metrics?.activityScore;
  const activityValue =
    typeof activity?.value === 'number' && Number.isFinite(activity.value) && activity.value >= 0
      ? String(activity.value)
      : null;
  const grade = profile?.grade ?? data.metrics?.grade?.value;
  return (
    <div className="weq-group-profile-data">
      <GroupCardContent
        conversation={data.conversation}
        metrics={data.metrics}
        joinedAt={data.joinedAt}
        ownerUid={data.ownerUid}
        memberCountKnown={data.memberCountKnown}
        full
        onOpenMembers={onOpenMembers}
        onOpenMember={onOpenMember}
      />
      {!data.conversation.generated ? (
        <ContactSection title="群状态">
          <ContactRow
            label="群等级"
            historyField="grade"
            value={
              typeof grade === 'number' && Number.isFinite(grade) && grade >= 0
                ? String(grade)
                : null
            }
          />
          <ContactRow label="活跃度" value={activityValue} />
          <ContactRow
            label="活跃成员"
            value={profile?.activeMemberCount != null ? `${profile.activeMemberCount} 人` : null}
          />
          {data.extendedError ? (
            <ContactInlineError
              message={data.extendedError}
              retrying={data.extendedRefreshing}
              onRetry={data.refreshExtended}
            />
          ) : null}
          {data.extendedRefreshing && !profile ? (
            <p className="weq-profile-empty" role="status">
              正在读取群状态…
            </p>
          ) : null}
        </ContactSection>
      ) : null}
    </div>
  );
}
