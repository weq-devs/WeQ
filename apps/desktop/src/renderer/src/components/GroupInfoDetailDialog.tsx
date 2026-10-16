/**
 * 群资料卡片 —— 消息页右侧「群资料」面板里点某个分组弹出来的那张卡。
 *
 * 原先住在 `im-template/template/groupInfoPanel.tsx`，2026-10-17 随「浮层统一」搬出来：
 * 模板只负责「点了一下 → 调回调」，卡片本体、样式与层级都归 WeQ 侧。
 *
 * 外壳走 {@link ./OverlayLayer}，于是 portal / 层级（overlayStack 发放）/ Esc /
 * 点遮罩关闭都是同一套，不再各自手写，也不会被模板自己的 95/96 或 opt-in 的 ≥1200 盖住。
 *
 * 数据由应用层给：`conversation` 是 MainView 已经组装好的群会话（含 `group` 各字段）。
 */

import { X } from 'lucide-react';
import { cn } from '../im-template/template/classNames';
import { formatShortDate } from '../im-template/template/format';
import type { GroupConversationView } from '../im-template/template/conversationDetailsTypes';
import type { GroupInfoDetail } from '../im-template/template/conversationDetails';
import { OverlayLayer } from './OverlayLayer';

export function GroupInfoDetailDialog({
  conversation,
  detail,
  onClose,
}: {
  conversation: GroupConversationView;
  detail: GroupInfoDetail;
  onClose: () => void;
}) {
  const group = conversation.group;
  const profileRows = [
    ['群名称', group.name],
    [group.identityLabel, group.identityValue],
    group.description ? ['群简介', group.description] : null,
    group.remark ? ['群备注', group.remark] : null,
    group.createTime ? ['创建时间', formatShortDate(group.createTime)] : null,
    group.maxMemberCount ? ['群容量', `${group.memberCount}/${group.maxMemberCount}`] : null,
    group.labels ? ['标签', group.labels] : null,
    group.customLabels?.length ? ['自定义标签', group.customLabels.join('、')] : null,
    group.addressName ? ['群地点', group.addressName] : null,
    group.entranceQ ? ['入群问题', group.entranceQ] : null,
  ].filter(Boolean) as string[][];

  return (
    <OverlayLayer className="modal-scrim group-info-detail-scrim" onClose={onClose}>
      <section
        className={cn('group-info-detail-dialog')}
        role="dialog"
        aria-modal="true"
        aria-label={groupInfoDetailTitle(detail)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{groupInfoDetailTitle(detail)}</strong>
            <span>{group.name}</span>
          </div>
          <button className={cn('icon-button')} type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className={cn('group-info-detail-body')}>
          {detail === 'profile' ? (
            <div className={cn('group-info-detail-rows')}>
              {profileRows.map(([label, value]) => (
                <div className={cn('group-info-detail-row')} key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </OverlayLayer>
  );
}

function groupInfoDetailTitle(_detail: GroupInfoDetail) {
  return '群资料';
}
