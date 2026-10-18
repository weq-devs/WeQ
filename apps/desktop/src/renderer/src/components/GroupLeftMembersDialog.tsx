// @ts-nocheck
/**
 * 「已退群成员」原位小浮窗（local group_member3，64016 = 1）。
 *
 * 状态与本地查询归 MainView，模板只留入口；小浮窗跟随入口定位并避让视口边缘。
 * 一行一个头像 + 显示名 + QQ 号，主题色与深浅模式自动跟随。
 */

import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import { Avatar, GroupMembersSkeleton } from '../im-template/template/primitives';
import { OverlayLayer } from './OverlayLayer';
import { cn } from '../im-template/template/classNames';
import '../styles/group-left-members.css';

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
  const rows = members.filter((member) => String(member.id ?? '').trim() !== '');

  return (
    <OverlayLayer
      presentation="popover"
      title="已退群成员"
      className={cn('modal-scrim', 'group-info-detail-scrim', 'weq-group-left-members-layer')}
      onClose={onClose}
    >
      <section
        className={cn('group-info-detail-dialog', 'weq-group-left-members')}
        role="dialog"
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
    </OverlayLayer>
  );
}
