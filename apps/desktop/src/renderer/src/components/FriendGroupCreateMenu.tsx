import { useEffect, useRef, useState } from 'react';
import { Plus, Search, UserPlus, UsersRound } from 'lucide-react';
import { useFriendDirectory } from './FriendDirectoryControls';
import { useRenderDocument } from '../lib/renderDocument';
import type { QQExactLookupKind } from './QQExactLookup';

/** 与会话列表共用目录工具栏的按钮尺寸、菜单定位和交互。 */
export function FriendGroupCreateMenu({
  onLookup,
  onCreateGroup,
  onQuickInvite,
  showGroup = true,
}: {
  onLookup: (kind: QQExactLookupKind) => void;
  onCreateGroup: () => void;
  onQuickInvite: () => void;
  showGroup?: boolean;
}) {
  const directory = useFriendDirectory();
  const document = useRenderDocument();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(root.current!)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [document, open]);
  return (
    <div
      className="weq-directory-scope"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        } else if (event.key === 'Tab') setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        title="添加联系人或分组"
        aria-label="添加联系人或分组"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div
          className="weq-directory-scope-menu"
          role="menu"
          aria-label="添加联系人菜单"
          onKeyDown={(event) => {
            const buttons = [
              ...(root.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ) ?? []),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLookup('user');
            }}
          >
            <Search size={16} />
            QQ 号搜索
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLookup('group');
            }}
          >
            <UsersRound size={16} />
            群号搜索
          </button>
          {showGroup && (
            <button
              type="button"
              role="menuitem"
              disabled={!directory?.available || directory.busy}
              title={directory?.error}
              onKeyDown={(event) => {
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                  event.preventDefault();
              }}
              onClick={() => {
                setOpen(false);
                directory?.create();
              }}
            >
              <Plus size={16} />
              新建分组
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCreateGroup();
            }}
          >
            <UsersRound size={16} />
            创建群聊
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onQuickInvite();
            }}
          >
            <UserPlus size={16} />
            添加好友/群聊
          </button>
        </div>
      )}
    </div>
  );
}
