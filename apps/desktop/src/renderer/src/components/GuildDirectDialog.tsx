/** 频道目录适配；完整聊天页唯一实现为 ChatPane。 */
import { formatConversationTime as formatChannelTime } from '@weq/time';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckSquare, Download, X } from 'lucide-react';
import { client } from '../trpc/client';
import type { Conversation, User } from '../im-template/template/types';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import { Avatar } from '../im-template/template/primitives';
import { Modal } from './Dialog';
import { ReadonlyConversationPane } from './ReadonlyConversationPane';
import { usePageDataCache, usePageState } from './PageSnapshots';
import { pageValue } from '../lib/pageSnapshots';
import { useContentMultiSelect, useRequestContentExport } from '../state/contentSelection';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { TimeLabel } from './TimeLabel';
import { unixDate } from '@weq/time';
import '../styles/channel.css';

export interface GuildSearchTarget {
  nodeId: string;
  msgId: string;
  msgSeq: string;
  revision: string;
}
type Session = Awaited<ReturnType<typeof client.account.guildDirectListSessions.query>>[number];

export function GuildDirectDialog({
  open,
  onClose,
  selfUser,
  renderers,
  embedded = false,
  chatOnly = false,
  active = open,
  searchTarget,
  onActiveSessionChange,
}: {
  open: boolean;
  onClose: () => void;
  selfUser: User;
  renderers?: MessageRenderer[];
  embedded?: boolean;
  chatOnly?: boolean;
  active?: boolean;
  searchTarget?: GuildSearchTarget | null;
  onActiveSessionChange?: (nodeId: string | null) => void;
}) {
  const cache = usePageDataCache();
  const [sessions, setSessions] = useState<Session[]>(
    () => cache.read<Session[]>('guild:sessions') ?? [],
  );
  const [nodeId, setNodeId] = usePageState<string | null>(
    'guild:selection',
    null,
    pageValue.optionalString,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const selectedId = searchTarget?.nodeId || nodeId;
  const selected = sessions.find((row) => row.nodeId === selectedId);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void client.account.guildDirectListSessions
      .query()
      .then((rows) => {
        if (cancelled) return;
        setSessions(rows);
        cache.write('guild:sessions', rows);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cache]);
  useEffect(() => {
    if (searchTarget?.nodeId) setNodeId(searchTarget.nodeId);
  }, [searchTarget?.nodeId, setNodeId]);
  useEffect(() => {
    onActiveSessionChange?.(active ? selectedId : null);
  }, [active, selectedId, onActiveSessionChange]);
  const selection = useContentMultiSelect(
    { kind: 'guild-conversations', container: 'guild-list' },
    active,
  );
  const multi = useMultiSelection({
    ids: sessions.map((row) => row.nodeId),
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    enabled: selection.selectionMode,
    disabled: !active,
    anchorRef: selection.anchorRef,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  const requestExport = useRequestContentExport();
  const conversation = useMemo<Conversation | undefined>(
    () =>
      selected
        ? {
            id: `guild:${selected.nodeId}`,
            directoryKind: 'guild',
            type: 'direct',
            updatedAt: unixDate(selected.lastTime)?.toISOString() ?? '',
            lastMessage: null,
            otherUser: {
              id: `guild:${selected.nodeId}`,
              identityLabel: '频道用户',
              identityValue: selected.peerTinyId,
              username: selected.peerTinyId,
              displayName: selected.peerNick || selected.peerTinyId,
              avatarUrl: selected.peerAvatarUrl,
            },
            group: null,
            members: [],
          }
        : undefined,
    [selected],
  );
  const target = useMemo(
    () => ({ kind: 'guild' as const, nodeId: selectedId ?? '' }),
    [selectedId],
  );
  if (!open) return null;
  const content = (
    <div
      className={`weq-guild-direct${embedded ? ' is-embedded' : ''}${chatOnly ? ' is-chat-only' : ''}${selected ? ' has-selected-session' : ''}`}
    >
      {!chatOnly ? (
        <header className="weq-guild-direct-head">
          <strong>频道私聊</strong>
          <button
            type="button"
            className="icon-button"
            title="返回"
            aria-label="返回"
            onClick={onClose}
          >
            <ArrowLeft size={18} />
          </button>
        </header>
      ) : null}
      <div className="weq-guild-direct-body">
        {!chatOnly ? (
          <aside className="weq-guild-direct-side">
            <div className="weq-guild-direct-side-title">
              <span>会话列表</span>
              <button
                type="button"
                className="icon-button"
                title="多选频道私聊"
                aria-label={selection.selectionMode ? '退出会话多选' : '多选频道私聊'}
                onClick={() => selection.setSelectionMode(!selection.selectionMode)}
              >
                {selection.selectionMode ? <X size={16} /> : <CheckSquare size={16} />}
              </button>
            </div>
            {selection.selectionMode ? (
              <div className="weq-guild-session-actions">
                <label>
                  <input
                    type="checkbox"
                    aria-label="全选频道私聊"
                    checked={
                      sessions.length > 0 &&
                      sessions.every((row) => selection.selectedIds.has(row.nodeId))
                    }
                    onChange={(event) =>
                      selection.setSelectedIds(
                        event.target.checked
                          ? new Set(sessions.map((row) => row.nodeId))
                          : new Set(),
                      )
                    }
                  />
                  全选
                </label>
                <button
                  type="button"
                  className="selection-action"
                  title="导出所选频道私聊"
                  aria-label="导出所选频道私聊"
                  disabled={!requestExport || !selection.selectedIds.size}
                  onClick={() =>
                    requestExport?.({
                      owner: { kind: 'guild-conversations', container: 'guild-list' },
                      scope: { type: 'items', ids: [...selection.selectedIds] },
                    })
                  }
                >
                  <Download size={17} />
                </button>
              </div>
            ) : null}
            <div className="weq-guild-direct-list" {...multi.rootProps}>
              {sessions.map((row) => (
                <button
                  key={row.nodeId}
                  type="button"
                  {...multi.itemProps(row.nodeId)}
                  className={`weq-guild-direct-item${selectedId === row.nodeId ? ' active' : ''}${selection.selectedIds.has(row.nodeId) ? ' is-multiselected' : ''}`}
                  onClick={() => {
                    if (!selection.selectionMode) setNodeId(row.nodeId);
                  }}
                >
                  <Avatar
                    name={row.peerNick || row.peerTinyId}
                    avatarUrl={row.peerAvatarUrl}
                    seed={row.peerTinyId}
                  />
                  <span className="weq-guild-direct-item-main">
                    <strong>{row.peerNick || row.peerTinyId}</strong>
                    <small>{row.guildName}</small>
                    <TimeLabel
                      value={Number(row.lastTime) > 0 ? Number(row.lastTime) * 1000 : null}
                    >
                      {formatChannelTime(
                        Number(row.lastTime) > 0 ? Number(row.lastTime) * 1000 : null,
                        Date.now(),
                        'channel',
                      )}
                    </TimeLabel>
                  </span>
                </button>
              ))}
              {error ? (
                <p role="alert">{error}</p>
              ) : !sessions.length ? (
                <p role="status">{loading ? '读取会话中…' : '没有频道私聊会话'}</p>
              ) : null}
            </div>
          </aside>
        ) : null}
        {conversation && selected ? (
          <ReadonlyConversationPane
            key={selected.nodeId}
            target={target}
            conversation={conversation}
            user={selfUser}
            renderers={renderers}
            anchorId={searchTarget?.msgId || undefined}
            anchorSeq={searchTarget?.msgSeq}
            anchorRevision={searchTarget?.revision}
            onBack={chatOnly ? onClose : () => setNodeId(null)}
            sourceDetails={[
              { label: '频道', value: selected.guildName },
              { label: '频道用户 ID', value: selected.peerTinyId },
              { label: '会话 ID', value: selected.nodeId },
            ]}
          />
        ) : (
          <div
            className="weq-guild-direct-empty"
            role={error || (searchTarget && !loading) ? 'alert' : 'status'}
          >
            {error ||
              (searchTarget && !loading
                ? '搜索命中的会话已删除或本地不可用'
                : '选择会话查看频道私聊')}
          </div>
        )}
      </div>
    </div>
  );
  return embedded ? (
    content
  ) : (
    <Modal onClose={onClose} width={1100}>
      {content}
    </Modal>
  );
}
