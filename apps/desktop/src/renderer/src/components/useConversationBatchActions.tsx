import { useContext, useId, useMemo, useState } from 'react';
import { ConversationDirectoryContext, virtualConversationRow } from '../lib/conversationDirectory';
import { conversationRoamingTarget } from '../lib/conversationActions';
import {
  conversationSupportsAction,
  conversationRowName,
  type ConversationBatchAction,
} from '../lib/conversationViews';
import type { Conversation } from '../im-template/template/types';
import { useRequestContentExport } from '../state/contentSelection';
import { Modal } from './Dialog';
import '../styles/conversation-directory.css';

/** 混选时保留原选区，明确确认后只把支持的目标交给操作。 */
export function useConversationBatchActions(conversations: Conversation[]) {
  const directory = useContext(ConversationDirectoryContext);
  const titleId = useId();
  const requestExport = useRequestContentExport();
  const [pending, setPending] = useState<{
    label: string;
    unsupported: Array<{ id: string; name: string }>;
    supported: number;
    run: () => void;
  } | null>(null);
  const rows = useMemo(
    () =>
      new Map([
        ...conversations.map((row) => [row.id, row] as const),
        ...(directory?.real ?? []).map((row) => [row.id, row] as const),
        ...(directory?.rows ?? []).map((row) => [row.id, row] as const),
        ...(directory?.virtual ?? []).map(
          (item) => [item.id, virtualConversationRow(item)] as const,
        ),
      ]),
    [conversations, directory?.real, directory?.rows, directory?.virtual],
  );
  const supports = (id: string, action: ConversationBatchAction) =>
    conversationSupportsAction(rows.get(id), action);
  const rosterIds = (ids: string[]) => [
    ...new Set(
      ids.flatMap((id) => {
        const row = rows.get(id);
        return supports(id, 'roster') && row?.type === 'group' ? [row.group.id] : [];
      }),
    ),
  ];
  const run = (ids: string[], action: ConversationBatchAction | 'unread') => {
    const supported: string[] = [];
    const unsupported: Array<{ id: string; name: string }> = [];
    for (const id of ids) {
      const row = rows.get(id);
      const allowed = supports(id, action === 'unread' ? 'read' : action);
      if (allowed) supported.push(id);
      else
        unsupported.push({
          id,
          name: row ? conversationRowName(row) : id,
        });
    }
    const execute = () => {
      if (!supported.length) return;
      const selected = supported.flatMap((id) => {
        const row = rows.get(id);
        return row ? [row] : [];
      });
      if (action === 'export') {
        if (directory?.onExportBatch) directory.onExportBatch(selected);
        else
          requestExport?.({
            owner: { kind: 'conversations', container: 'main-list' },
            scope: { type: 'items', ids: supported },
          });
      } else if (action === 'delete') void directory?.onDelete?.(selected);
      else if (action === 'roster')
        requestExport?.(
          ids.length === 1
            ? {
                owner: { kind: 'contacts', container: `group:${rosterIds(supported)[0]}` },
                scope: { type: 'all' },
              }
            : {
                owner: { kind: 'contacts', container: 'groups' },
                scope: { type: 'items', ids: rosterIds(supported) },
              },
        );
      else if (action === 'read' || action === 'unread')
        directory?.onReadState?.(
          supported.flatMap((id) => {
            const row = rows.get(id);
            return row ? [row] : [];
          }),
          action === 'unread',
        );
      else
        directory?.onRoaming?.(
          supported.flatMap((id) => {
            const target = conversationRoamingTarget(rows.get(id));
            return target ? [target] : [];
          }),
        );
    };
    if (unsupported.length)
      setPending({
        label:
          action === 'export'
            ? '导出'
            : action === 'delete'
              ? '永久删除'
              : action === 'roster'
                ? '导出群名单'
                : action === 'roaming'
                  ? '拉取漫游消息'
                  : action === 'unread'
                    ? '标为未读'
                    : '标为已读',
        unsupported,
        supported: supported.length,
        run: execute,
      });
    else execute();
  };
  return {
    rosterIds,
    supports,
    supportsAny: (ids: string[], action: ConversationBatchAction) =>
      ids.some((id) => supports(id, action)),
    runRoster: (ids: string[]) => run(ids, 'roster'),
    runDelete: (ids: string[]) => run(ids, 'delete'),
    exportAvailable: Boolean(requestExport || directory?.onExportBatch),
    roamingAvailable: Boolean(directory?.onRoaming),
    confirming: Boolean(pending),
    runExport: (ids: string[]) => run(ids, 'export'),
    runRoaming: (ids: string[]) => run(ids, 'roaming'),
    runReadState: (ids: string[], unread: boolean) => run(ids, unread ? 'unread' : 'read'),
    confirmation: pending ? (
      <Modal
        centered
        width={440}
        labelledBy={titleId}
        className="weq-conversation-action-confirm"
        onClose={() => setPending(null)}
      >
        <h3 id={titleId}>
          {pending.unsupported.length} 个会话不支持{pending.label}
        </h3>
        <ul>
          {pending.unsupported.map(({ id, name }) => (
            <li key={id}>{name}</li>
          ))}
        </ul>
        <p>
          {pending.supported
            ? `是否跳过以上会话，继续处理其余 ${pending.supported} 个会话？`
            : '没有可处理的会话，当前选区将保留。'}
        </p>
        <div>
          <button type="button" onClick={() => setPending(null)}>
            {pending.supported ? '取消' : '知道了'}
          </button>
          {pending.supported ? (
            <button
              type="button"
              onClick={() => {
                setPending(null);
                pending.run();
              }}
            >
              仅处理支持的会话
            </button>
          ) : null}
        </div>
      </Modal>
    ) : null,
  };
}
