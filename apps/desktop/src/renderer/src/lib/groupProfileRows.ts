import type { GroupProfileExtras } from '@weq/protocol';

/**
 * 群扩展资料的行数据。
 *
 * 约定（设计契约 §3）：
 * - label 用用户词（「群等级」而不是「群 grade」）。
 * - 没有可信值时不出行，不用「未知」占位。
 * - 协议/调试字段单独标记为 technical，由调用方收进默认折叠的技术详情。
 */
export type GroupProfileRow = readonly [label: string, value: string, technical?: boolean];

const freezeText = (profile: GroupProfileExtras | null) => {
  if (profile?.freezeState == null) return null;
  if (profile.freezeState === 0) return '正常';
  if (profile.freezeState === 1) return '已冻结';
  return `状态码 ${profile.freezeState}`;
};

export function groupProfileRows(profile: GroupProfileExtras | null): GroupProfileRow[] {
  const rows: GroupProfileRow[] = [];
  const freeze = freezeText(profile);
  if (profile?.grade != null) rows.push(['群等级', String(profile.grade)]);
  if (profile?.activeMemberCount != null)
    rows.push(['活跃成员', `${profile.activeMemberCount} 人`]);
  if (freeze) rows.push(['冻结状态', freeze]);
  if (profile?.freezeReason != null && (profile.freezeState === 1 || profile.freezeReason !== 0))
    rows.push(['冻结原因代码', String(profile.freezeReason), true]);
  if (profile?.portrait?.count != null)
    rows.push(['头像数量', String(profile.portrait.count), true]);
  if (profile?.portrait?.defaultId != null)
    rows.push(['默认头像编号', String(profile.portrait.defaultId), true]);
  if (profile?.portraitSequence != null)
    rows.push(['头像版本', String(profile.portraitSequence), true]);
  return rows;
}
