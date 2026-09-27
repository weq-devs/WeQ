// @ts-nocheck
/**
 * 「已退群成员」灯箱（local group_member3，64016 = 1）。
 *
 * 与群公告 / 群精华**同一层**：状态与数据查询都归应用层（MainView）——
 * `listGroupLeftMembers` 是纯本地表查询，不碰协议；模板层（im-template）只在群资料
 * 面板上留一个入口（`onOpenLeftMembers`），既不拉数据也不渲染这张灯箱。
 *
 * 一行一个头像 + 显示名 + QQ 号；外壳沿用群资料灯箱的 `modal-scrim` /
 * `group-info-detail-dialog`，主题色与深浅模式自动跟随。
 */

import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import { Avatar, GroupMembersSkeleton } from '../im-template/template/primitives';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { cn } from '../im-template/template/classNames';

/** 一行已退群成员（MainView 从 `listGroupLeftMembers` 的 wire 映射过来）。 */
export interface GroupLeftMemberRow {
  /** uid —— React key。 */
  id: string;
  /** 展示名：群名片 > 昵称 > QQ 号 > uid。 */
  displayName: string;
  /** QQ 号；拿不到时退回 uid。 */
  identity: string;
  avatarUrl?: string | null;
}

export function GroupLeftMembersDialog({
  groupName,
  members,
  loading,
  error,
  onClose,
}: {
  groupName: string;
  members: GroupLeftMemberRow[];
  loading: boolean;
  error?: string | null;
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);

  const rows = members.filter((member) => String(member.id ?? '').trim() !== '');

  return (
    <div
      className={cn('modal-scrim', 'group-info-detail-scrim')}
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className={cn('group-info-detail-dialog')}
        role="dialog"
        aria-modal="true"
        aria-label="已退群成员"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>已退群成员</strong>
            <span>{groupName}</span>
          </div>
          <button className={cn('icon-button')} type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className={cn('group-info-detail-body', 'group-left-member-body')}>
          {error ? (
            <div className={cn('group-info-member-error')}>加载失败：{error}</div>
          ) : loading && rows.length === 0 ? (
            <GroupMembersSkeleton rows={8} />
          ) : rows.length === 0 ? (
            <p className={cn('placeholder-text')}>暂无已退群成员</p>
          ) : (
            rows.map((member) => (
              <div className={cn('group-info-member-row')} key={member.id}>
                <div className="member-avatar-wrap">
                  <Avatar
                    name={member.displayName}
                    avatarUrl={member.avatarUrl}
                    seed={member.identity}
                  />
                </div>
                <span className="member-name-text">
                  <span className="member-name-with-badge">
                    <span className="member-display-name">{member.displayName}</span>
                  </span>
                </span>
                <small className={cn('group-left-member-id')}>{member.identity}</small>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
