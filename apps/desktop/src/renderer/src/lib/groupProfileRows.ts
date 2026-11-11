import type { GroupProfileExtras } from '@weq/protocol';

export function groupProfileRows(profile: GroupProfileExtras | null) {
  const rows: Array<[string, string]> = [
    ['群 grade', profile?.grade == null ? '未知' : String(profile.grade)],
    ['活跃成员', profile?.activeMemberCount == null ? '未知' : `${profile.activeMemberCount} 人`],
    [
      '冻结状态',
      profile?.freezeState == null
        ? '未知'
        : profile.freezeState === 0
          ? '正常'
          : profile.freezeState === 1
            ? '已冻结'
            : `状态码 ${profile.freezeState}`,
    ],
  ];
  if (profile?.freezeReason != null && (profile.freezeState === 1 || profile.freezeReason !== 0))
    rows.push(['冻结原因代码', String(profile.freezeReason)]);
  if (profile?.portrait?.count != null) rows.push(['头像数量', String(profile.portrait.count)]);
  if (profile?.portrait?.defaultId != null)
    rows.push(['默认头像编号', String(profile.portrait.defaultId)]);
  if (profile?.portraitSequence != null) rows.push(['头像版本', String(profile.portraitSequence)]);
  return rows;
}
