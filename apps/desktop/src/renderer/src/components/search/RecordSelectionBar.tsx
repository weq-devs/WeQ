import { messageDetailsTarget } from '../../lib/messageDetailsTarget';
import { useLayoutEffect, useRef, useState } from 'react';
import { Copy, Download, Forward, ListPlus, Share2, X } from 'lucide-react';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import type { Conversation, Message } from '../../im-template/template/types';
import { conversationExportSelection } from '../../lib/conversationActions';
import { messageContentText } from '../../lib/messageClipboard';
import { useRequestContentExport } from '../../state/contentSelection.shared';
import { client } from '../../trpc/client';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { MessageSelectionBar } from '../MessageSelectionBar';
import { useToast } from '../Toast.shared';
import type { RecordMessageActions } from './recordMessageActions';

export function RecordSelectionBar({
  count,
  conversation,
  binding,
  actions,
  pick,
  isCurrent,
  onExit,
}: {
  count: number;
  conversation: Conversation;
  binding?: QQWriteBinding;
  actions?: RecordMessageActions;
  pick: () => Message[];
  isCurrent: () => boolean;
  onExit: () => void;
}) {
  const requestExport = useRequestContentExport();
  const scope = conversationExportSelection(conversation);
  const pushToast = useToast((state) => state.push);
  const [forwardMenu, setForwardMenu] = useState<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const preparing = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function copy() {
    try {
      const text = pick()
        .map((row) => messageContentText(row.qqElements, row.body))
        .join('\n\n');
      if (!(await copyTextToClipboard(text))) throw new Error('未能写入剪贴板，请重新复制。');
      pushToast({ tone: 'success', title: '已复制所选消息' });
    } catch (error) {
      pushToast({ tone: 'error', title: '复制失败', detail: String(error) });
    }
  }

  async function withOriginals(run: (messages: Message[]) => unknown) {
    if (preparing.current) return;
    preparing.current = true;
    setBusy(true);
    const stillCurrent = () => mounted.current && isCurrent();
    try {
      const messages: Message[] = [];
      for (const row of pick()) {
        if (!stillCurrent()) return;
        if (row.qqElements?.length) {
          messages.push(row);
          continue;
        }
        const target = messageDetailsTarget(binding, conversation, row);
        const record = target ? await client.account.messageRecordDetails.query(target) : null;
        const body = record?.elements as Message['qqElements'];
        if (!body?.length) throw new Error('部分原消息正文暂不可用，请调整选区后重试。');
        messages.push({ ...row, qqElements: body });
      }
      if (stillCurrent() && messages.length) await run(messages);
    } catch (error) {
      if (stillCurrent())
        pushToast({ tone: 'error', title: '无法处理所选消息', detail: String(error) });
    } finally {
      preparing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const forward = actions?.forward;
  const merge = actions?.merge;
  const addMaterial = actions?.addMaterial;
  const forwardLabel = actions?.sendBlockedReason || '转发';
  const position = forwardMenu?.getBoundingClientRect();
  const disabled = !count || busy;
  return (
    <>
      <MessageSelectionBar count={count}>
        <button
          type="button"
          className="selection-action"
          aria-label="复制"
          title="复制"
          disabled={disabled}
          onClick={() => void copy()}
        >
          <Copy size={17} />
        </button>
        {forward ? (
          <button
            type="button"
            className="selection-action"
            aria-label="转发"
            aria-haspopup={merge ? 'menu' : undefined}
            title={forwardLabel}
            disabled={disabled || Boolean(actions?.sendBlockedReason)}
            onClick={(event) => {
              if (merge) setForwardMenu(event.currentTarget);
              else void withOriginals(forward);
            }}
          >
            <Share2 size={17} />
          </button>
        ) : null}
        {addMaterial ? (
          <button
            type="button"
            className="selection-action"
            aria-label="添加到素材库"
            title="添加到素材库"
            disabled={disabled}
            onClick={() => void withOriginals(addMaterial)}
          >
            <ListPlus size={17} />
          </button>
        ) : null}
        {requestExport && scope ? (
          <button
            type="button"
            className="selection-action"
            aria-label="导出所选消息"
            title="导出所选消息"
            disabled={disabled}
            onClick={() =>
              requestExport({ ...scope, scope: { type: 'items', ids: pick().map(({ id }) => id) } })
            }
          >
            <Download size={17} />
          </button>
        ) : null}
        <button
          type="button"
          className="selection-action"
          aria-label="退出多选"
          title="退出多选"
          onClick={onExit}
        >
          <X size={17} />
        </button>
      </MessageSelectionBar>
      {position && forward && merge ? (
        <ConversationActionsMenu
          x={position.right}
          y={position.top - 4}
          dropdown="above"
          scrollAnchor={forwardMenu ?? undefined}
          onClose={() => setForwardMenu(null)}
          label="转发方式"
          actions={[
            {
              label: '合并转发',
              icon: <Share2 size={16} />,
              action: () => void withOriginals(merge),
            },
            {
              label: '逐条转发',
              icon: <Forward size={16} />,
              action: () => void withOriginals(forward),
            },
          ]}
        />
      ) : null}
    </>
  );
}
