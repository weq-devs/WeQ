import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../../trpc/client';
import { TabActivity } from '../../components/RetainedTabs';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useWorkspaceMenu } from '../../state/workspaceMenu';
import type { AssistantActivity } from '../../lib/workspaceIndicators';
import { readWorkspaceResults, rememberWorkspaceResults } from '../../lib/workspaceReadState';
import {
  isAssistantSessionDeleted,
  markAssistantSessionDeleted,
  rememberAssistantSession,
} from '../../lib/assistantWorkspace';
import type { GeneratedSearchHit } from '../../components/search/types';
import { AssistantPanel } from './AssistantPanel';
import type { FlatModels } from './NewCloneModal';
import '../../styles/assistant-conversation.css';

const NO_DELETED_SESSIONS: readonly string[] = [];

interface PanelState {
  key: number;
  sessionId: string | null;
  activity: AssistantActivity;
  result?: string;
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
  onActivity,
  onCreated,
  onNewSession,
  onBackToDirectory,
}: {
  panel: PanelState;
  active: boolean;
  accountScope: string;
  title: string;
  models: FlatModels['chat'];
  onActivity: (key: number, activity: AssistantActivity, result?: string) => void;
  onCreated: (key: number, id: string) => void;
  onNewSession: () => void;
  onBackToDirectory?: () => void;
}) {
  const activity = useCallback(
    (next: AssistantActivity, result?: string) => onActivity(panel.key, next, result),
    [panel.key, onActivity],
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
        onActivityChange={activity}
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
      : [{ key: 0, sessionId, activity: 'idle', searchTarget: searchTarget ?? undefined }],
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
  const { enabled: visible } = useQQReadActivity(active, { onlineOnly: false });
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
      const retained = current.filter((panel) => panel.key === key || panel.activity === 'running');
      return existing
        ? retained.map((panel) =>
            panel.key === key ? { ...panel, searchTarget: searchTarget ?? undefined } : panel,
          )
        : [
            ...retained,
            { key, sessionId, activity: 'idle', searchTarget: searchTarget ?? undefined },
          ];
    });
    rememberAssistantSession(accountScope, sessionId);
  }, [accountScope, sessionId, searchTarget, requestKey, requestedDeleted]);

  const setAssistant = useWorkspaceMenu((state) => state.setAssistant);
  const onActivity = useCallback((key: number, activity: AssistantActivity, result?: string) => {
    setPanels((current) => {
      const panel = current.find((item) => item.key === key);
      if (!panel || (panel.activity === activity && panel.result === result)) return current;
      return current
        .map((item) => (item.key === key ? { ...item, activity, result } : item))
        .filter((item) => item.key === latest.current.selectedKey || item.activity === 'running');
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
      rememberAssistantSession(accountScope, id);
      latest.current.onSessionCreated?.(id);
    },
    [accountScope],
  );
  const newSession = useCallback(() => onNewSession?.(), [onNewSession]);
  const livePanels = useMemo(
    () => panels.filter((panel) => !sessionDeleted(panel.sessionId)),
    [panels, sessionDeleted],
  );
  const selected = livePanels.find((panel) => panel.key === selectedKey);
  useEffect(() => {
    const results = readWorkspaceResults(accountScope, 'assistant');
    if (selected?.sessionId && selected.activity === 'running' && results[selected.sessionId]) {
      delete results[selected.sessionId];
      rememberWorkspaceResults(accountScope, 'assistant', results);
    }
    if (visible && selected?.sessionId && selected.result) {
      results[selected.sessionId] = selected.result;
      rememberWorkspaceResults(accountScope, 'assistant', results);
    }
    const running = livePanels.some((panel) => panel.activity === 'running');
    const unread = livePanels.some(
      (panel) =>
        panel.activity === 'finished' &&
        (!visible || panel.key !== selectedKey) &&
        (!panel.sessionId || !panel.result || results[panel.sessionId] !== panel.result),
    );
    setAssistant(
      running ? 'running' : unread ? 'finished' : (selected?.activity ?? 'idle'),
      unread,
    );
  }, [accountScope, livePanels, selected, selectedKey, visible, setAssistant]);
  useEffect(() => () => setAssistant('idle'), [setAssistant]);

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
          onActivity={onActivity}
          onCreated={onCreated}
          onNewSession={newSession}
          onBackToDirectory={onBackToDirectory}
        />
      ))}
    </section>
  );
}
