import { useEffect, useRef, type RefObject } from 'react';
import { ListTodo } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import type { Conversation, Message } from '../../im-template/template/types';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { useTypingStatusSettings } from '../../hooks/useTypingStatusSettings';
import { ActionFeedback, useQQAction, useQQGroupPermissions } from './shared';

export function MessageTodoAction({
  conversation,
  message,
  onClose,
}: {
  conversation: Conversation;
  message: Message;
  onClose: () => void;
}) {
  const a = useQQAction(`todo:${conversation.id}:${message.id}`);
  const utils = trpc.useUtils();
  const permissions = useQQGroupPermissions(
    conversation.type === 'group' ? Number(conversation.id) : 0,
    a,
  );
  if (
    conversation.type !== 'group' ||
    !permissions.data?.canManage ||
    !message.msgSeq ||
    !/^[1-9]\d*$/.test(message.msgSeq)
  )
    return null;
  return (
    <>
      <button
        type="button"
        disabled={a.disabled}
        onClick={() =>
          void a.perform(
            (b) =>
              client.account.qqActions.todo.mutate({
                ...b,
                groupId: Number(conversation.id),
                sequence: message.msgSeq!,
                action: 'set',
              }),
            async () => {
              await utils.account.qqActions.todoList.invalidate({
                ...a.binding!,
                groupId: Number(conversation.id),
              });
              onClose();
            },
            '将这条群消息设为群待办？',
            {
              readback: async () => {
                const rows = await client.account.qqActions.todoList.query({
                  ...a.binding!,
                  groupId: Number(conversation.id),
                });
                return rows.some((row) => String(row.sequence) === message.msgSeq);
              },
            },
          )
        }
      >
        <ListTodo size={17} />
        <span>设为群待办</span>
      </button>
      <ActionFeedback action={a} />
    </>
  );
}

/**
 * 按设置里的「隐藏正在输入的状态」，在私聊输入框有输入时广播输入状态，
 * 最多每十秒一次；不猜测未核实的“停止输入”枚举。
 *
 * 默认向对方展示输入状态（设置里的模式为 off）；只有命中「按会话勾选」或
 * 「永久全选」时才不再广播。这里不渲染任何开关按钮 —— 私聊输入框右上角
 * 不再有输入状态开关。
 */
export function TypingStatus({
  uid,
  editors,
}: {
  uid: string;
  editors: RefObject<HTMLDivElement | null>[];
}) {
  const session = useQQWriteSession(`typing:${uid}`);
  const preferences = useTypingStatusSettings();
  const accountUin = session.binding?.expectedAccountUin;
  const accountConfigId = session.binding?.expectedAccountConfigId;
  const settings = preferences.query.data;
  const hiddenHere =
    settings?.mode === 'selected' &&
    settings.hidden.some(
      (item) =>
        item.accountUin === accountUin &&
        item.accountConfigId === accountConfigId &&
        item.uid === uid,
    );
  const enabled =
    !preferences.query.isError &&
    !preferences.disabled &&
    !!settings &&
    !(settings.mode === 'all' || hiddenHere);
  const latest = useRef(session);
  latest.current = session;
  const identity = `${accountUin}:${accountConfigId}:${uid}`;
  const refs = useRef(editors);
  refs.current = editors;
  useEffect(() => {
    if (!enabled) return;
    let last = Number.NEGATIVE_INFINITY;
    const input = () => {
      const s = latest.current;
      if (!s.available || s.busy || Date.now() - last < 10_000) return;
      last = Date.now();
      void s.run(
        (b) => client.account.qqActions.inputStatus.mutate({ ...b, uid, eventType: 1 }),
        undefined,
        { refreshCaches: false },
      );
    };
    const nodes = refs.current.map((r) => r.current).filter((n): n is HTMLDivElement => Boolean(n));
    for (const node of nodes) node.addEventListener('input', input);
    return () => {
      for (const node of nodes) node.removeEventListener('input', input);
    };
  }, [enabled, uid, identity]);
  return null;
}
