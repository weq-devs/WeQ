import { useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, ListTodo, Radio } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import type { Conversation, Message } from '../../im-template/template/types';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { ActionFeedback, ActionIcon, useQQAction, useQQGroupPermissions } from './shared';

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

/** 只在用户主动开启后广播，最多每十秒一次；不猜测未核实的“停止输入”枚举。 */
export function TypingStatus({
  uid,
  editors,
}: {
  uid: string;
  editors: RefObject<HTMLDivElement | null>[];
}) {
  const session = useQQWriteSession(`typing:${uid}`);
  const [enabled, setEnabled] = useState(false);
  const latest = useRef(session);
  latest.current = session;
  const identity = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}:${uid}`;
  const refs = useRef(editors);
  refs.current = editors;
  useEffect(() => {
    setEnabled(false);
  }, [identity]);
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
  return (
    <button
      type="button"
      className="composer-tool weq-qq-typing-toggle"
      aria-label="发送正在输入状态"
      aria-pressed={enabled}
      title={`发送正在输入状态（${enabled ? '已开启' : '已关闭'}）${session.result?.error ? `：${session.result.text}` : ''}`}
      disabled={!session.available}
      onClick={() => setEnabled((value) => !value)}
    >
      <Keyboard size={21} strokeWidth={1.5} />
      {session.result?.error && (
        <span className="sr-only" role="alert">
          {session.result.text}
        </span>
      )}
    </button>
  );
}

export function LiveStatusReadout() {
  const a = useQQAction('live-status'),
    [open, setOpen] = useState(false);
  const status = trpc.account.qqActions.liveStatus.useQuery(
    { ...a.binding! },
    { enabled: open && a.available, retry: false, staleTime: 15_000 },
  );
  const names: Record<number, string> = {
    0: '离线',
    10: '在线',
    30: '离开',
    40: '隐身',
    50: '忙碌',
    60: 'Q我吧',
    70: '勿扰',
  };
  return (
    <div className="weq-qq-actions weq-qq-live-status">
      <div className="weq-qq-action-bar">
        <span className="weq-qq-live-status-label">
          <Radio size={13} strokeWidth={2} aria-hidden />
          服务端状态
        </span>
        <ActionIcon
          label="查询服务端在线状态"
          disabled={a.disabled || status.isFetching}
          onClick={() => {
            if (open) void status.refetch();
            else setOpen(true);
          }}
        >
          <Radio size={16} />
        </ActionIcon>
        {open && (
          <span role="status" className="weq-qq-live-status-value">
            {status.isFetching
              ? '查询中…'
              : status.data
                ? `${names[status.data.status] ?? `状态 ${status.data.status}`}${status.data.extStatus ? ` · 扩展 ${status.data.extStatus}` : ''}`
                : '服务端未返回状态'}
          </span>
        )}
      </div>
      {status.error && <p role="alert">{status.error.message}</p>}
    </div>
  );
}
