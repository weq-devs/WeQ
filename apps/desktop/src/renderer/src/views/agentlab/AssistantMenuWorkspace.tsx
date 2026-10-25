import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquarePlus, MessagesSquare, RefreshCw, Trash2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { AssistantPanel } from './AssistantPanel';
import { RetainedTabs, useTabActive } from '../../components/RetainedTabs';
import type { GeneratedSearchHit } from '../../components/search/types';
import { useAppDialog } from '../../lib/dialogUtils';
import '../../styles/agentlab-workspace.css';
import {
  readAssistantSession,
  rememberAssistantSession,
  rememberAssistantDraft,
} from '../../lib/assistantWorkspace';

export function AssistantMenuWorkspace({
  accountScope,
  compact,
  searchTarget,
}: {
  accountScope: string;
  compact: boolean;
  searchTarget?: GeneratedSearchHit | null;
}) {
  const active = useTabActive();
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const sessions = trpc.account.listAssistantSessions.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, { enabled: active });
  const remove = trpc.account.deleteAssistantSession.useMutation();
  const [selection, setSelection] = useState(() => ({
    sessionId: readAssistantSession(accountScope),
    key: 'initial',
    searchTarget: undefined as GeneratedSearchHit | undefined,
  }));
  const sequence = useRef(0);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const keys = useRef(new Map<string, string>());
  const appliedSearch = useRef<GeneratedSearchHit | null | undefined>(undefined);
  const models = useMemo(
    () =>
      (providers.data ?? []).flatMap((provider) =>
        provider.models
          .filter((model) => model.capabilities.includes('chat'))
          .map((model) => ({
            key: `${provider.id}::${model.id}`,
            providerId: provider.id,
            model: model.id,
            label: `${provider.name} · ${model.label ?? model.id}`,
          })),
      ),
    [providers.data],
  );

  function select(sessionId: string | null, target?: GeneratedSearchHit) {
    if (sessionId === selection.sessionId && !target) return;
    const nextKey = sessionId ? keys.current.get(sessionId) : undefined;
    const panelKey = nextKey ?? `session-${++sequence.current}`;
    if (sessionId) keys.current.set(sessionId, panelKey);
    rememberAssistantSession(accountScope, sessionId);
    setSelection({ sessionId, key: panelKey, searchTarget: target });
  }
  function newSession() {
    rememberAssistantDraft(accountScope, null, '');
    rememberAssistantSession(accountScope, null);
    setSelection({ sessionId: null, key: `draft-${++sequence.current}`, searchTarget: undefined });
  }
  useEffect(() => {
    if (selection.sessionId) keys.current.set(selection.sessionId, selection.key);
  }, [selection.sessionId, selection.key]);
  useEffect(() => {
    if (
      searchTarget?.kind !== 'assistant' ||
      !searchTarget.sessionId ||
      appliedSearch.current === searchTarget
    )
      return;
    appliedSearch.current = searchTarget;
    const sessionId = searchTarget.sessionId;
    const panelKey = keys.current.get(sessionId) ?? `search-${++sequence.current}`;
    keys.current.set(sessionId, panelKey);
    rememberAssistantSession(accountScope, sessionId);
    setSelection({ sessionId, key: panelKey, searchTarget });
  }, [accountScope, searchTarget]);
  useEffect(() => {
    if (
      !sessions.isSuccess ||
      sessions.isFetching ||
      !selection.sessionId ||
      sessions.data.some((session) => session.id === selection.sessionId)
    )
      return;
    rememberAssistantSession(accountScope, null);
    setSelection({ sessionId: null, key: `draft-${++sequence.current}`, searchTarget: undefined });
  }, [sessions.data, sessions.isSuccess, sessions.isFetching, selection.sessionId, accountScope]);

  async function deleteSession(sessionId: string) {
    if (
      !(await dialog.confirm('删除会话', '确认删除这段对话？删除后无法恢复。', {
        okLabel: '删除',
        tone: 'warning',
      }))
    )
      return;
    try {
      await remove.mutateAsync({ sessionId });
      rememberAssistantDraft(accountScope, sessionId, '');
      if (selection.sessionId === sessionId) select(null);
      await utils.account.listAssistantSessions.invalidate();
    } catch (error) {
      dialog.error('删除会话失败', error instanceof Error ? error.message : String(error));
    }
  }
  const ready =
    sessions.isSuccess &&
    (!selection.sessionId || sessions.data.some((session) => session.id === selection.sessionId));
  return (
    <div className={`weq-assistant-workspace${compact ? ' is-compact' : ''}`}>
      <aside className="weq-assistant-sessions" hidden={compact} aria-label="助手会话">
        <button type="button" className="weq-set-btn" onClick={newSession}>
          <MessageSquarePlus size={16} />
          新建会话
        </button>
        {(sessions.data ?? []).map((session) => (
          <div key={session.id} className="weq-assistant-session-row">
            <button
              type="button"
              aria-current={session.id === selection.sessionId ? 'true' : undefined}
              onClick={() => select(session.id)}
              title={session.title}
            >
              <MessagesSquare size={16} />
              <span>{session.title || '新会话'}</span>
            </button>
            <button
              type="button"
              title="删除会话"
              aria-label={`删除会话 ${session.title}`}
              onClick={() => void deleteSession(session.id)}
              disabled={remove.isLoading}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </aside>
      <section className="weq-assistant-conversation">
        {!ready ? (
          <div className="weq-workspace-empty" role="status">
            {sessions.error ? (
              <>
                <span>读取助手会话失败</span>
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  title="重试"
                  aria-label="重新读取助手会话"
                  onClick={() => void sessions.refetch()}
                >
                  <RefreshCw size={16} />
                </button>
              </>
            ) : (
              '读取会话中…'
            )}
          </div>
        ) : null}
        <RetainedTabs activeKey={ready ? selection.key : 'loading'}>
          {ready ? (
            <AssistantPanel
              sessionId={selection.sessionId}
              searchTarget={selection.searchTarget}
              chatModels={models}
              compact={compact}
              draftAccount={accountScope}
              workspaceTitle={
                sessions.data.find((session) => session.id === selection.sessionId)?.title ??
                '新会话'
              }
              onBack={newSession}
              onSessionCreated={(id) => {
                keys.current.set(id, selection.key);
                if (currentSelection.current.key !== selection.key) return;
                rememberAssistantSession(accountScope, id);
                setSelection((current) =>
                  current.key === selection.key ? { ...current, sessionId: id } : current,
                );
              }}
            />
          ) : null}
        </RetainedTabs>
      </section>
    </div>
  );
}
