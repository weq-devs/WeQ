import { eventTimeFormatter as groupTimeFormatter } from '@weq/time';
import { useContext } from 'react';
import { ContactFieldHistoryContext as Context } from '../../lib/contactFieldHistoryContext.shared';
import { CONTACT_HISTORY_DISPLAY_ENABLED } from '../../lib/contactHistoryVisibility';

export const contactHistoryFieldForLabel: Record<string, string> = {
  昵称: 'nick',
  备注: 'remark',
  个性签名: 'signature',
  QQ: 'uin',
  QID: 'qid',
  UID: 'uid',
  性别: 'gender',
  年龄: 'age',
  生日: 'birthday',
  星座: 'birthday',
  生肖: 'zodiac',
  血型: 'bloodType',
  所在地: 'region',
  职业: 'occupation',
  学校: 'school',
  公司: 'company',
  邮箱: 'email',
  个人说明: 'description',
  'QQ 等级': 'level',
  累计获赞: 'likes',
  已开通特权: 'privileges',
  'QQ 能量值': 'energy',
  能量值: 'energy',
  共同好友: 'commonFriends',
  共同群: 'commonGroups',
  'QQ 亲密度': 'intimacy',
  关系标签: 'relations',
  互动标识: 'marks',
  个性标签: 'labels',
  标签: 'labels',
  个性装扮: 'dress',
  匿问我答: 'questions',
  头像: 'avatar',
  精选照片: 'photos',
  'QQ 秀': 'qqShow',
  添加时间: 'addedAt',
  添加方向: 'direction',
  添加来源: 'source',
  来源群: 'sourceGroup',
  群昵称: 'card',
  专属头衔: 'customTitle',
  群角色: 'role',
  群等级: 'groupLevel',
  入群时间: 'joinedAt',
  最后群发言: 'lastSpeakAt',
  禁言截止: 'muteUntil',
  群名称: 'groupName',
  简介: 'description',
  创建时间: 'createTime',
  我的入群时间: 'joinedAt',
  群地点: 'addressName',
  入群问题: 'entranceQ',
  群容量: 'maxMemberCount',
  群成员数: 'memberCount',
  群内好友数: 'friendCount',
  活跃度: 'activityScore',
  活跃成员: 'activeMemberCount',
  冻结状态: 'freezeState',
};

export function useContactFieldHistoryAvailable(label: string, field?: string) {
  const context = useContext(Context);
  const key = field ?? contactHistoryFieldForLabel[label];
  return CONTACT_HISTORY_DISPLAY_ENABLED && Boolean(context && key && context.fields.includes(key));
}

/** 群字段的历史沿用当前资料的业务单位，不向弹窗暴露 Unix 秒或标签内部字段。 */
export function groupFieldHistoryValue(
  entity: string,
  memberUid: string | undefined,
  field: string,
  value: unknown,
): unknown {
  if (!entity.startsWith('group:') || memberUid) return value;
  if (['createTime', 'joinedAt'].includes(field) && typeof value === 'number' && value > 1)
    return groupTimeFormatter.format(value * 1000);
  if (
    ['memberCount', 'maxMemberCount', 'friendCount', 'activeMemberCount'].includes(field) &&
    typeof value === 'number'
  )
    return `${value} 人`;
  if (field === 'freezeState' && typeof value === 'number')
    return value === 0 ? '正常' : value === 1 ? '已冻结' : `状态码 ${value}`;
  if (field === 'labels' && value && typeof value === 'object' && !Array.isArray(value)) {
    const labels = value as { labels?: unknown; customLabels?: unknown };
    return [
      ...new Set(
        [labels.labels, labels.customLabels].flatMap((list) =>
          Array.isArray(list)
            ? list.filter((item): item is string => typeof item === 'string')
            : [],
        ),
      ),
    ];
  }
  return value;
}
