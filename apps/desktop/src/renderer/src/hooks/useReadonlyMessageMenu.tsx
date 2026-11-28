import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { MessageDetails } from '../components/lazyMainPanels';
import { useMediaSave } from '../components/MediaSaveControls.shared';
import { useToast } from '../components/Toast.shared';
import {
  MessageContextMenu,
  type MessageContextMenuState,
  type MessageDetailsSelection,
} from '../im-template/template/messageContextMenu';
import type { Conversation, Message, User } from '../im-template/template/types';
import { messageContentClipboard, selectedMessageClipboard } from '../lib/messageClipboard';
import { messageDetailsTarget } from '../lib/messageDetailsTarget';
import { messageMediaSaveSource, messageMediaTarget } from '../lib/messageMediaTarget';
import { writeMentionClipboard } from '../lib/mentionClipboard';
import { isSelfIdentity, selfIdentityValues } from '../lib/selfIdentity';
import type { QQWriteBinding } from './useQQWriteSession';

type LocateMessage = (message: Message) => void | Promise<void>;

export function useReadonlyMessageMenu({
  conversation,
  user,
  detailsBinding,
  scope,
  onLocate,
  enterOpensMenu = false,
}: {
  conversation: Conversation | null;
  user?: User | null;
  detailsBinding?: QQWriteBinding | null;
  scope: string;
  onLocate?: LocateMessage;
  enterOpensMenu?: boolean;
}) {
  const [state, setState] = useState<(MessageContextMenuState & { scope: string }) | null>(null);
  const [details, setDetails] = useState<{
    selection: MessageDetailsSelection;
    scope: string;
  } | null>(null);
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> }>(
    null,
  );
  const consumed = useRef(0);
  const mediaSave = useMediaSave();
  const toast = useToast((state) => state.push);
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  const closeMenu = () => setState(null);
  useEffect(() => cancelPress, [cancelPress, scope]);

  function open(
    message: Message,
    row: HTMLElement,
    target: EventTarget | null,
    point: { x: number; y: number },
    variant: 'desktop' | 'mobile',
  ) {
    const selection = row.ownerDocument.getSelection();
    const clipboard =
      selection?.rangeCount && selection.getRangeAt(0).intersectsNode(row)
        ? selectedMessageClipboard()
        : null;
    setState({
      ...point,
      scope,
      message,
      variant,
      originElement: row,
      mediaTarget: messageMediaTarget(message, target),
      ...(clipboard ? { clipboard } : {}),
    });
  }

  function rowProps<T extends HTMLElement>(message: Message): HTMLAttributes<T> {
    return {
      onContextMenuCapture: (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelPress();
        if (Date.now() < consumed.current) return;
        const row = event.currentTarget;
        const rect = row.getBoundingClientRect();
        open(
          message,
          row,
          event.target,
          {
            x: event.clientX || rect.left,
            y: event.clientY || rect.bottom,
          },
          'desktop',
        );
      },
      onKeyDownCapture: (event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        const rowEnter =
          enterOpensMenu && event.key === 'Enter' && event.target === event.currentTarget;
        if (!rowEnter && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
          return;
        event.preventDefault();
        event.stopPropagation();
        const row = event.currentTarget;
        const rect = row.getBoundingClientRect();
        open(message, row, event.target, { x: rect.left, y: rect.bottom }, 'desktop');
      },
      onPointerDownCapture: (event) => {
        cancelPress();
        consumed.current = 0;
        if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) return;
        const { pointerId, clientX: x, clientY: y, currentTarget, target } = event;
        press.current = {
          id: pointerId,
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            consumed.current = Date.now() + 1000;
            open(message, currentTarget, target, { x, y }, 'mobile');
          }, 460),
        };
      },
      onPointerMoveCapture: (event) => {
        const start = press.current;
        if (
          start?.id === event.pointerId &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
        )
          cancelPress();
      },
      onPointerUpCapture: cancelPress,
      onPointerCancelCapture: cancelPress,
      onPointerLeave: cancelPress,
      onClickCapture: (event) => {
        if (Date.now() >= consumed.current) return;
        event.preventDefault();
        event.stopPropagation();
        consumed.current = 0;
      },
    };
  }

  const media = state?.mediaTarget ? messageMediaSaveSource(state.mediaTarget) : null;
  const menu =
    state?.scope === scope ? (
      <MessageContextMenu
        state={state}
        metadataPrecision={conversation?.generated ? 'millisecond' : 'second'}
        onClose={closeMenu}
        onCopy={async (message) => {
          closeMenu();
          const value =
            state.clipboard ?? messageContentClipboard(message.qqElements, message.body);
          try {
            if (await writeMentionClipboard(value)) return;
          } catch {
            // 剪贴板不可写时沿用同一提示。
          }
          toast({ tone: 'warning', title: '未能写入剪贴板，请重新复制' });
        }}
        onViewDetails={
          state.message.qqElements?.length
            ? (selection) => setDetails({ selection, scope })
            : undefined
        }
        onSaveMedia={
          media
            ? () => {
                closeMenu();
                void mediaSave.run(media);
              }
            : undefined
        }
        downloadDisabled={mediaSave.disabled}
        onLocate={
          onLocate
            ? () => {
                closeMenu();
                void Promise.resolve()
                  .then(() => onLocate(state.message))
                  .catch((error: unknown) =>
                    toast({
                      tone: 'warning',
                      title: '定位原消息失败',
                      detail: error instanceof Error ? error.message : undefined,
                    }),
                  );
              }
            : undefined
        }
      />
    ) : null;
  return {
    rowProps,
    mediaSave,
    menu: (
      <>
        {menu}
        {details?.scope === scope && conversation ? (
          <MessageDetails
            selection={details.selection}
            conversation={conversation}
            user={user ?? undefined}
            target={
              detailsBinding?.expectedAccountUin === user?.identityValue
                ? messageDetailsTarget(detailsBinding, conversation, details.selection.message)
                : undefined
            }
            isSender={Boolean(
              user &&
                isSelfIdentity(
                  new Set(selfIdentityValues(user)),
                  details.selection.message.senderId,
                ),
            )}
            onClose={() => setDetails(null)}
          />
        ) : null}
      </>
    ),
  };
}
