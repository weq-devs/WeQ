import type { GroupConversation } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { ProfileAvatar } from './ProfileAvatar';
import { profileTimeText } from '@weq/protocol/profile-values';
import { ContactRow } from './contactProfile/ContactRow';
import '../styles/profile-cache.css';

/**
 * 群标签来源（谁在什么时候打的标签）。
 *
 * 以前这里把每条标签渲染成 `<details>` 折叠块，在名片与概览里显示成「▶ 音乐」「▶ 拼车」
 * 一排三角，展开后往往只有「设置者：未记录」。现在标签值本身走 chip（`GroupTags`），
 * 这里只在详细资料里以数据行列出「标签 → 设置者 · 时间」，没有可信来源的行直接不渲染。
 */
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
  const rows = (records ?? [])
    .filter((record) => record.setterUid || record.setTimestamp)
    .map((record, index) => {
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
      return {
        key: `${record.labelId ?? index}:${record.content}`,
        label: record.content || '未命名标签',
        setter:
          record.setterUid && name ? (
            <ProfileAvatar
              target={{
                identity: record.setterUid,
                uin: member?.uin,
                name,
                avatarUrl: member?.avatarUrl,
                group: { code: group.id, name: group.name },
              }}
            >
              {name}
            </ProfileAvatar>
          ) : null,
        time,
      };
    });
  if (!rows.length) return null;
  return (
    <section className="weq-group-label-sources" aria-label="标签来源">
      {rows.map((row) => (
        <ContactRow
          key={row.key}
          label={row.label}
          value={
            row.setter || row.time ? (
              <>
                {row.setter}
                {row.setter && row.time ? ' · ' : null}
                {row.time ? `${row.time}（北京时间）` : null}
              </>
            ) : null
          }
        />
      ))}
    </section>
  );
}
