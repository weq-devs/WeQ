import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { LocateFixed } from 'lucide-react';
import { ConversationActionsMenu } from '../components/ConversationActionsMenu';
import type { ReplyJumpTarget } from '../state/messageContext';

/** 只读消息视图共用定位菜单；原消息身份由各自宿主提供。 */
export function useMessageLocateMenu(
  onLocate: ((target: ReplyJumpTarget) => void | Promise<void>) | undefined,
  scope: string,
) {
  const [menu, setMenu] = useState<{ x: number; y: number; target: ReplyJumpTarget } | null>(null);
  const [error, setError] = useState('');
  const current = useRef(scope);
  current.current = scope;
  useEffect(() => {
    current.current = scope;
    setMenu(null);
    setError('');
    return () => {
      current.current = '';
    };
  }, [scope]);
  return {
    openMenu: (event: MouseEvent, target: ReplyJumpTarget) => {
      if (!onLocate || (!target.seq && !target.msgId)) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, target });
    },
    error,
    menu:
      menu && onLocate ? (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="消息定位"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: '定位到原消息',
              icon: <LocateFixed size={16} />,
              action: () => {
                const started = scope;
                setError('');
                void Promise.resolve()
                  .then(() => {
                    if (current.current === started) return onLocate(menu.target);
                  })
                  .catch((reason: unknown) => {
                    if (current.current === started)
                      setError(reason instanceof Error ? reason.message : '定位失败，请重试');
                  });
              },
            },
          ]}
        />
      ) : null,
  };
}
