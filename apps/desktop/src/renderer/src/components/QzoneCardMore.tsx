import { useRef, useState, type RefObject } from 'react';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { visibleViewport } from '../lib/visibleViewport';
import { ConversationActionsMenu, type ConversationMenuAction } from './ConversationActionsMenu';
import '../styles/qzone-archive.css';

export function QzoneCardMore({
  actions,
  busy = false,
  triggerRef,
}: {
  actions: ConversationMenuAction[];
  busy?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const close = () => {
    setMenu(null);
    trigger.current?.focus({ preventScroll: true });
  };
  if (!actions.length) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="weq-qzn-archive-menu-button"
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-busy={busy || undefined}
        onClick={(event) => {
          if (menu) {
            close();
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const viewport = visibleViewport(event.currentTarget.ownerDocument.defaultView);
          const below = viewport.top + viewport.height - rect.bottom;
          const above = below < actions.length * 44 + 22 && rect.top - viewport.top > below;
          setMenu({ x: rect.right, y: above ? rect.top - 4 : rect.bottom + 4, above });
        }}
      >
        {busy ? <Loader2 size={16} className="weq-spin" /> : <MoreHorizontal size={16} />}
      </button>
      {menu ? (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          dropdown={menu.above ? 'above' : true}
          label="空间动态操作"
          onClose={close}
          actions={actions}
        />
      ) : null}
    </>
  );
}
