import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../../trpc/client';
import { TabActivity } from '../../components/RetainedTabs';
import {
  isAssistantSessionDeleted,
  markAssistantSessionDeleted,
} from '../../lib/assistantWorkspace';
import type { GeneratedSearchHit } from '../../components/search/types';
import { AssistantPanel } from './AssistantPanel';
import type { FlatModels } from './NewCloneModal';

const NO_DELETED_SESSIONS: readonly string[] = [];

interface PanelState {
  key: number;
  sessionId: string | null;
  running: boolean;
  searchTarget?: GeneratedSearchHit;
}

export interface AssistantConversationPaneProps {
  accountScope: string;
  sessionId: string | null;
  searchTarget?: GeneratedSearchHit | null;
  active?: boolean;
  /** 同一个空草稿被显式重新新建时改变此值。 */
  requestKey?: number;
  onSessionCreated?: (sessionId: string) => void;
  onNewSession?: () => void;
  onBackToDirectory?: () => void;
  deletedSessionIds?: readonly string[];
}

function ConversationPanel({
  panel,
  active,
  accountScope,
  title,
  models,
  onRunningChange,
  onCreated,
  onNewSession,
  onBackToDirectory,
}: {
  panel: PanelState;
  active: boolean;
  accountScope: string;
  title: string;
  models: FlatModels['chat'];
  onRunningChange: (key: number, running: boolean) => void;
  onCreated: (key: number, id: string) => void;
  onNewSession: () => void;
  onBackToDirectory?: () => void;
}) {
  const runningChange = useCallback(
    (running: boolean) => onRunningChange(panel.key, running),
    [panel.key, onRunningChange],
  );
  const created = useCallback((id: string) => onCreated(panel.key, id), [panel.key, onCreated]);
  return (
    <TabActivity active={active}>
      <AssistantPanel
        sessionId={panel.sessionId}
        searchTarget={panel.searchTarget}
        chatModels={models}
        draftAccount={accountScope}
        workspaceTitle={title}
        headless={!active}
        onRunningChange={runningChange}
        onSessionCreated={created}
        onBack={onNewSession}
        onBackToDirectory={onBackToDirectory}
      />
    </TabActivity>
  );
}

/** 主聊天区域的助手宿主；切走的生成仅保留控制器，不保留隐藏聊天 DOM。 */
export function AssistantConversationPane({ ...props }: AssistantConversationPaneProps) {
  return <AssistantConversationWorkspace key={props.accountScope} {...props} />;
}

function AssistantConversationWorkspace({
  accountScope,
  sessionId,
  searchTarget,
  active = true,
  requestKey = 0,
  onSessionCreated,
  onNewSession,
  onBackToDirectory,
  deletedSessionIds = NO_DELETED_SESSIONS,
}: AssistantConversationPaneProps) {
  const deleted = useMemo(() => new Set(deletedSessionIds), [deletedSessionIds]);
  const sessionDeleted = useCallback(
    (id: string | null) =>
      Boolean(id && (deleted.has(id) || isAssistantSessionDeleted(accountScope, id))),
    [accountScope, deleted],
  );
  const requestedDeleted =
    sessionDeleted(sessionId) || sessionDeleted(searchTarget?.sessionId ?? null);
  const sequence = useRef(0);
  const [panels, setPanels] = useState<PanelState[]>(() =>
    requestedDeleted
      ? []
      : [{ key: 0, sessionId, running: false, searchTarget: searchTarget ?? undefined }],
  );
  const [selectedKey, setSelectedKey] = useState(0);
  const latest = useRef({ panels, selectedKey, onSessionCreated });
  latest.current = { panels, selectedKey, onSessionCreated };
  useLayoutEffect(() => {
    for (const id of deletedSessionIds) markAssistantSessionDeleted(accountScope, id);
    setPanels((current) => {
      const retained = current.filter((panel) => !sessionDeleted(panel.sessionId));
      return retained.length === current.length ? current : retained;
    });
  }, [deletedSessionIds, accountScope, sessionDeleted]);
  const previousRequest = useRef({ sessionId, searchTarget, requestKey });
  const sessions = trpc.account.listAssistantSessions.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const knownSessions = useRef(new Set<string>());
  useLayoutEffect(() => {
    if (!sessions.data || !sessions.isSuccess || sessions.isFetching) return;
    const current = new Set(sessions.data.map((session) => session.id));
    const missing = [...knownSessions.current].filter((id) => !current.has(id));
    knownSessions.current = current;
    if (!missing.length) return;
    for (const id of missing) markAssistantSessionDeleted(accountScope, id);
    setPanels((previous) => previous.filter((panel) => !sessionDeleted(panel.sessionId)));
  }, [sessions.data, sessions.isSuccess, sessions.isFetching, accountScope, sessionDeleted]);
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery(undefined, { enabled: active });
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

  useEffect(() => {
    const previous = previousRequest.current;
    if (requestedDeleted) {
      previousRequest.current = { sessionId, searchTarget, requestKey };
      setSelectedKey(-1);
      return;
    }
    if (
      previous.sessionId === sessionId &&
      previous.searchTarget === searchTarget &&
      previous.requestKey === requestKey
    )
      return;
    previousRequest.current = { sessionId, searchTarget, requestKey };
    const forceNewDraft = sessionId === null && previous.requestKey !== requestKey;
    const existing = forceNewDraft
      ? undefined
      : latest.current.panels.find((panel) => panel.sessionId === sessionId);
    const key = existing?.key ?? ++sequence.current;
    setSelectedKey(key);
    setPanels((current) => {
      const retained = current.filter((panel) => panel.key === key || panel.running);
      return existing
        ? retained.map((panel) =>
            panel.key === key ? { ...panel, searchTarget: searchTarget ?? undefined } : panel,
          )
        : [
            ...retained,
            { key, sessionId, running: false, searchTarget: searchTarget ?? undefined },
          ];
    });
  }, [sessionId, searchTarget, requestKey, requestedDeleted]);

  const onRunningChange = useCallback((key: number, running: boolean) => {
    setPanels((current) => {
      const panel = current.find((item) => item.key === key);
      if (!panel || panel.running === running) return current;
      return current
        .map((item) => (item.key === key ? { ...item, running } : item))
        .filter((item) => item.key === latest.current.selectedKey || item.running);
    });
  }, []);
  const onCreated = useCallback(
    (key: number, id: string) => {
      if (
        isAssistantSessionDeleted(accountScope, id) ||
        !latest.current.panels.some((panel) => panel.key === key)
      )
        return;
      setPanels((current) =>
        current.map((panel) => (panel.key === key ? { ...panel, sessionId: id } : panel)),
      );
      if (latest.current.selectedKey !== key) return;
      latest.current.onSessionCreated?.(id);
    },
    [accountScope],
  );
  const newSession = useCallback(() => onNewSession?.(), [onNewSession]);
  const livePanels = useMemo(
    () => panels.filter((panel) => !sessionDeleted(panel.sessionId)),
    [panels, sessionDeleted],
  );
  return (
    <section className="weq-assistant-main-conversation" aria-label="WeQ 助手会话" hidden={!active}>
      {requestedDeleted ? (
        <div className="weq-workspace-empty" role="status">
          这段助手会话已永久删除。
        </div>
      ) : null}
      {livePanels.map((panel) => (
        <ConversationPanel
          key={panel.key}
          panel={panel}
          active={active && !requestedDeleted && panel.key === selectedKey}
          accountScope={accountScope}
          title={
            sessions.data?.find((session) => session.id === panel.sessionId)?.title ??
            '新建 WeQ 助手会话'
          }
          models={models}
          onRunningChange={onRunningChange}
          onCreated={onCreated}
          onNewSession={newSession}
          onBackToDirectory={onBackToDirectory}
        />
      ))}
    </section>
  );
}
