import type { GroupConversation } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { ProfileAvatar } from './ProfileAvatar';
import { profileTimeText } from '@weq/protocol/profile-values';
import '../styles/profile-cache.css';

export function GroupLabelSources({
  group,
  members = [],
}: {
  group: GroupConversation['group'];
  members?: GroupConversation['members'];
}) {
  const records: GroupConversation['group']['customLabelRecords'] =
    group.customLabelRecords ?? group.customLabels?.map((content) => ({ content }));
  const byUid = new Map(members.map((member) => [member.uid || member.id, member]));
  const occurrences = new Map<string, number>();
  return records?.length ? (
    <div className="weq-label-sources">
      {records.map((record) => {
        const identity = JSON.stringify([
          record.groupCode,
          record.labelId,
          record.setterUid,
          record.setTimestamp,
          record.content,
        ]);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        const member = record.setterUid ? byUid.get(record.setterUid) : undefined;
        const name = member
          ? member.remark?.trim() ||
            member.card?.trim() ||
            member.nick?.trim() ||
            displayUserName(member)
          : record.setterUid;
        const time =
          record.setTimestamp && /^\d+$/.test(record.setTimestamp)
            ? profileTimeText(Number(record.setTimestamp))
            : null;
        return (
          <details key={`${identity}:${occurrence}`}>
            <summary>{record.content || '标签内容未记录'}</summary>
            <div className="weq-label-source-info">
              <span>
                设置者：
                {record.setterUid ? (
                  <ProfileAvatar
                    target={{
                      identity: record.setterUid,
                      uin: member?.uin,
                      name: name || record.setterUid,
                      avatarUrl: member?.avatarUrl,
                      group: { code: group.id, name: group.name },
                    }}
                  >
                    {name}
                  </ProfileAvatar>
                ) : (
                  '未记录'
                )}
              </span>
              <span>设置时间：{time ? `${time}（北京时间）` : '未记录'}</span>
            </div>
          </details>
        );
      })}
    </div>
  ) : null;
}
