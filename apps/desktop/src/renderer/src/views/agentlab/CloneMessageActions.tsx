import { useRef, useState, type ComponentProps } from 'react';
import { MessageSquareText } from 'lucide-react';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';

/** 沿用普通会话的消息管理图标与菜单，仅接入克隆数据支持的动作。 */
export function CloneMessageActions({
  actions,
}: {
  actions: ComponentProps<typeof ConversationActionsMenu>['actions'];
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button group-header-info-action weq-conversation-message-actions"
        title="消息管理"
        aria-label="消息管理"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => (menu ? setMenu(null) : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            open();
          }
        }}
      >
        <MessageSquareText size={18} />
      </button>
      {menu ? (
        <ConversationActionsMenu
          {...menu}
          label="消息管理"
          onClose={() => {
            setMenu(null);
            trigger.current?.focus({ preventScroll: true });
          }}
          actions={actions}
        />
      ) : null}
    </>
  );
}
