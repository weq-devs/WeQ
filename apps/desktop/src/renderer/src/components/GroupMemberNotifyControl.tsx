import { Bell, Check, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { GROUP_MEMBER_NOTIFY_OPTIONS, useGroupMemberNotify } from '../hooks/useGroupMemberNotify';
import { ProfileRow } from '../im-template/template/profilePanes';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { useViewState } from '../state/view';
import '../styles/group-member-notify.css';

export function GroupMemberNotifyControl({
  groupId,
  uid,
  memberUin,
}: {
  groupId: number;
  uid: string;
  memberUin?: string;
}) {
  const selfUin = useViewState((s) => s.openedUin);
  if (
    !Number.isSafeInteger(groupId) ||
    groupId <= 0 ||
    groupId > 0xffffffff ||
    !/^u_[A-Za-z0-9_-]+$/.test(uid)
  )
    return null;
  if (memberUin && memberUin === selfUin) return null;
  return <MemberNotifyRow key={`${groupId}:${uid}`} groupId={groupId} uid={uid} />;
}

function MemberNotifyRow({ groupId, uid }: { groupId: number; uid: string }) {
  const notify = useGroupMemberNotify(groupId, uid);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const label =
    GROUP_MEMBER_NOTIFY_OPTIONS.find((option) => option.mode === notify.mode)?.label ??
    (notify.loading ? '读取中…' : '未取得状态');
  return (
    <>
      <ProfileRow
        icon={<Bell size={13} />}
        label="群内消息提醒"
        value={label}
        action={
          <button
            type="button"
            className="weq-profile-row-copy"
            title={notify.reason ?? '设置群内消息提醒'}
            aria-label="设置群内消息提醒"
            aria-haspopup="menu"
            aria-expanded={Boolean(anchor)}
            disabled={notify.busy || notify.loading}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setAnchor({ x: rect.right, y: rect.bottom + 4 });
            }}
          >
            <ChevronDown size={14} />
          </button>
        }
      />
      {anchor ? (
        <ConversationActionsMenu
          x={anchor.x}
          y={anchor.y}
          dropdown
          label="群内消息提醒"
          onClose={() => setAnchor(null)}
          actions={[
            ...GROUP_MEMBER_NOTIFY_OPTIONS.map((option) => ({
              label: option.label,
              icon: (
                <Check
                  size={15}
                  style={{ visibility: notify.mode === option.mode ? 'visible' : 'hidden' }}
                />
              ),
              checked: notify.mode === option.mode,
              disabled: notify.disabled,
              reason: notify.reason,
              keepOpen: true,
              action: () => {
                void notify.change(option.mode).then((ok) => {
                  if (ok) setAnchor(null);
                });
              },
            })),
            {
              label: '重新读取',
              icon: <RefreshCw size={15} />,
              disabled: notify.loading || notify.busy || !notify.canRetry,
              keepOpen: true,
              reason: notify.reason,
              action: () => {
                void notify.retry();
              },
            },
          ]}
        />
      ) : null}
    </>
  );
}

/** 关闭的右键菜单不挂载查询 hook。 */
export function GroupMemberNotifyMenuItem({
  groupId,
  uid,
  onClose,
}: {
  groupId: number;
  uid: string;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="avatar-context-menu-mute"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={17} />
        <span>群内消息提醒</span>
        <ChevronRight size={14} className="avatar-context-menu-caret" />
      </button>
      {open ? <MemberNotifyChoices groupId={groupId} uid={uid} onClose={onClose} /> : null}
    </>
  );
}

function MemberNotifyChoices({
  groupId,
  uid,
  onClose,
}: {
  groupId: number;
  uid: string;
  onClose?: () => void;
}) {
  const notify = useGroupMemberNotify(groupId, uid);
  return (
    <div
      className="avatar-context-submenu weq-member-notify-choices"
      role="menu"
      aria-label="群内消息提醒"
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const index = buttons.indexOf(
          event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        event.stopPropagation();
        buttons[next]?.focus();
      }}
    >
      {notify.reason ? (
        <span className="weq-member-notify-status" role="status">
          {notify.loading ? '读取中…' : notify.reason}
        </span>
      ) : null}
      {GROUP_MEMBER_NOTIFY_OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          role="menuitemradio"
          aria-checked={notify.mode === option.mode}
          disabled={notify.disabled}
          title={notify.reason ?? option.label}
          onClick={() => {
            void notify.change(option.mode).then((ok) => {
              if (ok) onClose?.();
            });
          }}
        >
          <Check
            size={14}
            style={{ visibility: notify.mode === option.mode ? 'visible' : 'hidden' }}
          />
          <span>{option.label}</span>
        </button>
      ))}
      <button
        type="button"
        disabled={notify.loading || notify.busy || !notify.canRetry}
        title="重新读取群内消息提醒"
        onClick={() => {
          void notify.retry();
        }}
      >
        <RefreshCw size={14} />
        <span>重新读取</span>
      </button>
    </div>
  );
}
