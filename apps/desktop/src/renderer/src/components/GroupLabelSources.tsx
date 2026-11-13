import type { GroupConversation } from '../im-template/template/types';
import { Avatar } from '../im-template/template/primitives';
import { displayUserName } from '../im-template/template/user';
import { ProfileAvatar } from './ProfileAvatar';
import { profileTimeText } from '@weq/protocol/profile-values';
import { HoverPopover } from './HoverPopover';
import { useGroupLabelSetter } from '../hooks/useGroupLabelSetter';
import { avatarFromUin } from '../lib/avatarResolver';
import '../styles/group-label-sources.css';

/**
 * 标签只展示一次，设置来源跟随标签悬停或聚焦展开。
 */
export function GroupLabelSources({
  group,
  members = [],
}: {
  group: GroupConversation['group'];
  members?: GroupConversation['members'];
}) {
  const records = group.customLabelRecords ?? [];
  const labels = [
    ...new Set(
      [
        ...(group.labels ? group.labels.split(/[,，、;；\s]+/) : []),
        ...(group.customLabels ?? []),
        ...records.map((record) => record.content),
      ]
        .map((label) => label?.trim())
        .filter((label): label is string => Boolean(label)),
    ),
  ];
  const byUid = new Map(members.map((member) => [member.uid || member.id, member]));
  if (!labels.length) return null;
  return (
    <div className="weq-group-tags" aria-label="群标签" data-privacy-sensitive>
      {labels.map((label) => {
        const sources = records.filter(
          (record) =>
            record.content?.trim() === label &&
            (record.setterUid ||
              (record.setTimestamp &&
                /^\d+$/.test(record.setTimestamp) &&
                profileTimeText(Number(record.setTimestamp)))),
        );
        if (!sources.length)
          return (
            <span className="weq-profile-tag" key={label}>
              {label}
            </span>
          );
        return (
          <HoverPopover
            key={label}
            label={`${label}的来源`}
            classPrefix="weq-group-label"
            trigger={(open) => (
              <button
                type="button"
                className="weq-profile-tag weq-group-label-trigger"
                aria-expanded={open}
                aria-label={`${label}，标签来源`}
              >
                {label}
              </button>
            )}
          >
            <div className="weq-group-label-sources" data-privacy-sensitive>
              {sources.map((record, index) => {
                const member = record.setterUid ? byUid.get(record.setterUid) : undefined;
                const time =
                  record.setTimestamp && /^\d+$/.test(record.setTimestamp)
                    ? profileTimeText(Number(record.setTimestamp))
                    : null;
                return (
                  <div
                    className="weq-group-label-source"
                    key={`${record.labelId ?? index}:${record.setterUid ?? ''}`}
                  >
                    {record.setterUid ? (
                      <GroupLabelSetter group={group} uid={record.setterUid} member={member} />
                    ) : null}
                    {time ? (
                      <span className="weq-group-label-time">设置时间：{time}（北京时间）</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </HoverPopover>
        );
      })}
    </div>
  );
}

function GroupLabelSetter({
  group,
  uid,
  member,
}: {
  group: GroupConversation['group'];
  uid: string;
  member?: GroupConversation['members'][number];
}) {
  const localName = member?.remark?.trim() || member?.card?.trim() || member?.nick?.trim();
  const localUin = member?.uin && /^[1-9]\d{4,19}$/.test(member.uin) ? member.uin : undefined;
  const query = useGroupLabelSetter(group.id, uid, !localName || !(member?.avatarUrl || localUin));
  const resolved = query.data;
  const name =
    localName ||
    resolved?.remark ||
    resolved?.card ||
    resolved?.nick ||
    (member ? displayUserName(member) : uid);
  const uin = localUin || resolved?.uin;
  const avatarUrl = member?.avatarUrl || resolved?.avatarUrl || avatarFromUin(uin);
  return (
    <>
      <div className="weq-group-label-setter-row">
        <span className="weq-group-label-caption">设置者</span>
        <ProfileAvatar
          className="weq-group-label-setter weq-identity-link"
          target={{
            identity: uid,
            uin,
            name,
            avatarUrl,
            group: { code: group.id, name: group.name },
            member,
          }}
        >
          <Avatar name={name} avatarUrl={avatarUrl} seed={uid} />
          <span>{name}</span>
        </ProfileAvatar>
      </div>
      {query.isError || resolved?.error ? (
        <span className="weq-group-label-time" role="status">
          设置者资料暂未补全
        </span>
      ) : null}
    </>
  );
}
