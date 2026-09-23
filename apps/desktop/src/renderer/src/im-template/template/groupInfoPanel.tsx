// @ts-nocheck
import { Bot, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { Avatar, GroupInfoSkeleton, GroupMembersSkeleton } from './primitives';
import type { GroupMemberSearchView } from '../../hooks/useGroupMemberSearch';
import type { GroupConversationView } from './conversationDetailsTypes';
import { displayUserName } from './user';
import { cn } from './classNames';

export type GroupInfoDetail = 'profile' | 'albums';

export function GroupInfoPanel({
  conversation,
  onLoadMoreMembers,
  loadingMoreMembers,
  loadingError,
  memberSearch,
  onMemberSearchChange,
  onLoadMoreSearch,
  profileLoading,
  onOpenDetail,
  onOpenMember,
}: {
  conversation: GroupConversationView;
  onLoadMoreMembers?: () => void;
  loadingMoreMembers?: boolean;
  loadingError?: string | null;
  /**
   * 群内成员搜索状态（服务端搜全群，见 useGroupMemberSearch）。为空时退化为
   * 只在已加载的成员分页里过滤。
   */
  memberSearch?: GroupMemberSearchView | null;
  /** 搜索关键字变化（受控）。 */
  onMemberSearchChange?: (keyword: string) => void;
  /** 追加下一页搜索命中。 */
  onLoadMoreSearch?: () => void;
  /** 群详情（群资料）拉取中且资料尚未就绪时，meta 区域显示 skeleton。 */
  profileLoading?: boolean;
  onOpenDetail?: (detail: GroupInfoDetail) => void;
  onOpenMember?: (
    member: GroupConversationView['members'][number],
    anchor: { x: number; y: number },
  ) => void;
}) {
  const memberListRef = useRef<HTMLDivElement | null>(null);
  const group = conversation.group;
  const metaRows = [
    group.description ? ['群简介', group.description] : null,
    group.remark ? ['群备注', group.remark] : null,
    group.createTime ? ['创建时间', formatShortDate(group.createTime)] : null,
    group.maxMemberCount ? ['群容量', `${group.memberCount}/${group.maxMemberCount}`] : null,
    group.labels ? ['标签', group.labels] : null,
    group.customLabels?.length ? ['自定义标签', group.customLabels.join('、')] : null,
    group.addressName ? ['群地点', group.addressName] : null,
    group.entranceQ ? ['入群问题', group.entranceQ] : null,
  ].filter(Boolean) as string[][];

  const keyword = (memberSearch?.keyword ?? '').trim();
  const searching = keyword.length > 0;
  // 搜索命中的成员与成员分页是两套数据，但渲染形状一样（都在 MainView 映射）。
  const searchMembers = memberSearch?.members ?? [];
  // 搜索还没生效（防抖 / 请求在飞）时，命中列表为空但不能报「没找到」——
  // 结果没回来之前只能用 loading 占位。
  const searchPending = Boolean(memberSearch?.loading);
  const rows = searching ? searchMembers : conversation.members;
  // 搜索与成员分页各自有错误 / 加载态，这里归一成一份，JSX 只判一个分支。
  const activeError = searching ? (memberSearch?.error ?? null) : loadingError;
  const fetching = searching ? searchPending : Boolean(loadingMoreMembers);
  const fetchingMore = searching ? Boolean(memberSearch?.loadingMore) : Boolean(loadingMoreMembers);

  const requestMoreNearBottom = useCallback(() => {
    const list = memberListRef.current;
    if (!list) return;
    const distanceToBottom = list.scrollHeight - list.clientHeight - list.scrollTop;
    if (distanceToBottom > 96) return;
    if (searching) {
      if (memberSearch?.hasMore) onLoadMoreSearch?.();
      return;
    }
    onLoadMoreMembers?.();
  }, [searching, memberSearch?.hasMore, onLoadMoreSearch, onLoadMoreMembers]);

  // 列表比容器短时没有滚动事件，只能渲染后自己探一次底部；搜索把列表变短
  // （甚至空）时同样要重跑，否则「加载更多」永远不会被触发。
  useEffect(() => {
    const list = memberListRef.current;
    if (!list) return undefined;
    const frame = window.requestAnimationFrame(requestMoreNearBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [rows.length, searching, requestMoreNearBottom]);

  return (
    <aside className={cn('group-info-panel')} aria-label="群聊资料">
      <section className={cn('group-info-section', 'group-info-overview')}>
        <header className={cn('group-info-heading')}>
          <button
            className={cn('group-info-title-button')}
            type="button"
            title="查看群资料"
            onClick={() => onOpenDetail?.('profile')}
          >
            <strong>群资料</strong>
          </button>
        </header>
        <div className={cn('group-info-meta-list')}>
          {metaRows.length > 0 ? (
            metaRows.map(([label, value]) => (
              <button
                className={cn('group-info-meta-row')}
                type="button"
                key={label}
                onClick={() => onOpenDetail?.('profile')}
              >
                <span>{label}</span>
                <strong>{value}</strong>
              </button>
            ))
          ) : profileLoading ? (
            <GroupInfoSkeleton />
          ) : (
            <p className={cn('placeholder-text')}>暂无更多资料</p>
          )}
        </div>
      </section>

      <section className={cn('group-info-section', 'member-list-section')}>
        <header className={cn('group-info-heading group-info-title-row')}>
          <strong>
            群聊成员{' '}
            {searching
              ? `${rows.length}/${memberSearch?.total ?? 0}`
              : conversation.group.memberCount}
          </strong>
        </header>
        <div className={cn('group-info-member-search')}>
          <Search size={13} />
          <input
            type="text"
            value={memberSearch?.keyword ?? ''}
            placeholder="搜索昵称 / 群名片 / QQ号"
            aria-label="搜索群成员"
            spellCheck={false}
            onChange={(event) => onMemberSearchChange?.(event.target.value)}
          />
          {memberSearch?.keyword ? (
            <button
              className={cn('group-info-member-search-clear')}
              type="button"
              title="清除搜索"
              aria-label="清除搜索"
              onClick={() => onMemberSearchChange?.('')}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <div
          className={cn('group-info-member-list')}
          ref={memberListRef}
          onScroll={requestMoreNearBottom}
        >
          {searching && rows.length === 0 && !fetching ? (
            <div className={cn('group-info-member-empty')}>没有匹配的成员</div>
          ) : null}
          {rows.map((member) => (
            <div
              className={cn(
                'group-info-member-row',
                onOpenMember && 'is-clickable',
                member.role === 'owner' && 'is-owner',
                member.role === 'admin' && 'is-admin',
              )}
              key={member.id}
              role={onOpenMember ? 'button' : undefined}
              tabIndex={onOpenMember ? 0 : undefined}
              title={onOpenMember ? '查看资料' : undefined}
              onClick={
                onOpenMember
                  ? (event) => onOpenMember(member, { x: event.clientX, y: event.clientY })
                  : undefined
              }
              onKeyDown={
                onOpenMember
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        onOpenMember(member, {
                          x: rect.left + rect.width / 2,
                          y: rect.bottom,
                        });
                      }
                    }
                  : undefined
              }
            >
              <div className="member-avatar-wrap">
                <Avatar
                  name={displayUserName(member)}
                  avatarUrl={member.avatarUrl}
                  seed={member.identityValue}
                />
              </div>
              <span className="member-name-text">
                <span className="member-name-with-badge">
                  <span className="member-display-name">{displayUserName(member)}</span>
                  {member.role === 'owner' ? (
                    <small className="member-badge owner">群主</small>
                  ) : member.role === 'admin' ? (
                    <small className="member-badge admin">管理员</small>
                  ) : null}
                </span>
              </span>
              {member.kind === 'bot' ? (
                <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                  <Bot size={12} strokeWidth={2.4} />
                </small>
              ) : null}
            </div>
          ))}
          {searching && rows.length > 0 && memberSearch?.hasMore ? (
            <div className={cn('group-info-member-hint')}>
              已显示 {rows.length} / {memberSearch?.total ?? 0} 位匹配成员，继续滚动加载更多
            </div>
          ) : null}
          {activeError ? (
            <div className={cn('group-info-member-error')}>加载失败：{activeError}</div>
          ) : fetching && rows.length === 0 ? (
            <GroupMembersSkeleton rows={8} />
          ) : fetchingMore ? (
            <div className={cn('group-info-member-loading')}>
              <GroupMembersSkeleton rows={1} />
            </div>
          ) : null}
        </div>
      </section>
    </aside>
  );
}

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

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className={cn('modal-scrim', 'group-info-detail-scrim')}
      role="presentation"
      onMouseDown={onClose}
    >
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
    </div>
  );
}

function groupInfoDetailTitle(_detail: GroupInfoDetail) {
  return '群资料';
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
