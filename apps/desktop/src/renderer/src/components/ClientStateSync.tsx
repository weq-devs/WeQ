import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { displayPreferenceKeys } from '@weq/service/client-preferences';
import type { SettingsChange } from '@weq/service/settings-changes';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useNotificationPolicy } from '../lib/notificationPolicy';
import {
  remoteWorkspaceCheckPending,
  subscribeRemoteWorkspaceCheck,
} from '../lib/remoteWorkspaceCheck';
import {
  acceptAccountState,
  acceptPreferences,
  bindAccountState,
  initializePreferences,
  migrateAccountState,
  retryPreferences,
  useClientPreferences,
} from '../lib/clientPreferences';

function coalesceSnapshotReads(read: () => Promise<void>) {
  let running = false;
  let pending = false;
  let disposed = false;
  async function flush() {
    running = true;
    try {
      while (pending) {
        pending = false;
        await read();
      }
    } finally {
      running = false;
    }
  }
  return {
    request() {
      if (disposed) return;
      pending = true;
      if (!running) void flush();
    },
    dispose() {
      disposed = true;
      pending = false;
    },
  };
}

type SettingsUtils = ReturnType<typeof trpc.useUtils>;
const displaySettings = new Set<string>(displayPreferenceKeys);

function invalidateModelSettings(utils: SettingsUtils) {
  void utils.bootstrap.getAgentLabDefaultModel.invalidate();
  void utils.bootstrap.getDefaultVisionModel.invalidate();
  void utils.bootstrap.getDefaultEmbeddingModel.invalidate();
}

function invalidateSettingsChange(utils: SettingsUtils, change?: SettingsChange) {
  void utils.bootstrap.getSettings.invalidate();
  if (!change) {
    // 恢复、配置重读和旧宿主未提供字段时，保留完整校准。
    invalidateModelSettings(utils);
    void utils.settings.invalidate();
    void utils.account.intentSense.getStatus.invalidate();
    void utils.account.antiRecall.getStatus.invalidate();
    void utils.account.getAssistantConfig.invalidate();
    void utils.account.getAccountConfig.invalidate();
    void utils.account.dressup.getState.invalidate();
    void utils.account.annualReport.getManifest.invalidate();
    void utils.mail.preferences.invalidate();
    return true;
  }
  const { fields, groups, clientFields } = change;
  const models = fields.includes('agentLab');
  const notifications = fields.includes('notificationEvents');
  if (models) invalidateModelSettings(utils);
  if (models || fields.includes('modelResources') || groups.includes('intent')) {
    void utils.settings.intent.getStatus.invalidate();
    void utils.account.intentSense.getStatus.invalidate();
  }
  if (notifications || groups.includes('antiRecall')) {
    void utils.settings.antiRecall.getStatus.invalidate();
    void utils.account.antiRecall.getStatus.invalidate();
  }
  if (groups.includes('assistant')) {
    void utils.settings.assistant.getConfig.invalidate();
    void utils.account.getAssistantConfig.invalidate();
  }
  if (groups.includes('dress')) {
    void utils.settings.dress.get.invalidate();
    void utils.account.dressup.getState.invalidate();
  }
  if (groups.includes('annualReport')) {
    void utils.settings.annualReport.get.invalidate();
    void utils.account.annualReport.getManifest.invalidate();
  }
  if (notifications || groups.includes('mail')) {
    void utils.settings.mail.get.invalidate();
    void utils.mail.preferences.invalidate();
  }
  if (clientFields.some((field) => field.startsWith('dataSaver'))) {
    void utils.settings.dataSaver.status.invalidate();
    void utils.settings.networkCost.invalidate();
  }
  return (
    notifications ||
    groups.includes('client') ||
    groups.includes('order') ||
    fields.some((field) => displaySettings.has(field))
  );
}

/** 应用只保留一份订阅；消息与首屏无需等待同步服务。 */
export function ClientStateSync() {
  const checkingWorkspace = useSyncExternalStore(
    subscribeRemoteWorkspaceCheck,
    remoteWorkspaceCheckPending,
  );
  const notificationSettings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: !checkingWorkspace,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (notificationSettings.data?.notificationEvents)
      useNotificationPolicy.getState().setEvents(notificationSettings.data.notificationEvents);
  }, [notificationSettings.data?.notificationEvents]);
  const utils = trpc.useUtils();
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const saveError = useClientPreferences((state) => state.error);
  const [readFailed, setReadFailed] = useState(false);
  const refreshPreferences = useRef<(() => void) | null>(null);
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  useEffect(() => {
    // 离线工作区先可见，此时传输层尚不允许读取共享设置。
    if (checkingWorkspace) return;
    let active = true;
    let initialize = false;
    const snapshots = coalesceSnapshotReads(async () => {
      if (initialize) {
        initialize = false;
        await initializePreferences().then(
          () => active && setReadFailed(false),
          () => active && !remoteWorkspaceCheckPending() && setReadFailed(true),
        );
      } else {
        await client.clientState.snapshot
          .query()
          .then((snapshot) => {
            if (active) {
              acceptPreferences(snapshot);
              setReadFailed(false);
            }
          })
          .catch(() => {});
      }
    });
    const refresh = () => {
      if (!active || remoteWorkspaceCheckPending()) return;
      initialize = true;
      snapshots.request();
      void utils.bootstrap.getSettings.invalidate();
      invalidateModelSettings(utils);
    };
    refreshPreferences.current = refresh;
    refresh();
    const sub = client.clientState.changed.subscribe(undefined, {
      onStarted: refresh,
      onData: (event) => {
        if (active && invalidateSettingsChange(utils, event.settings)) snapshots.request();
      },
    });
    return () => {
      active = false;
      refreshPreferences.current = null;
      snapshots.dispose();
      sub.unsubscribe();
    };
  }, [checkingWorkspace, utils]);
  useEffect(() => {
    const refresh = () => {
      const state = useWorkspaceMenu.getState();
      if (state.taskScope) state.syncTasks(state.taskScope, state.taskItems);
    };
    window.addEventListener('weq-shared-account-state', refresh);
    return () => window.removeEventListener('weq-shared-account-state', refresh);
  }, []);
  useEffect(() => {
    if (!uin || !configId) {
      bindAccountState(null);
      return;
    }
    const binding = { expectedAccountUin: uin, expectedAccountConfigId: configId };
    bindAccountState(binding);
    let active = true;
    const snapshots = coalesceSnapshotReads(async () => {
      await client.clientState.accountSnapshot
        .query(binding)
        .then(async (snapshot) => {
          if (active) {
            acceptAccountState(snapshot, binding);
            await migrateAccountState(binding);
          }
        })
        .catch(() => {});
    });
    snapshots.request();
    const sub = client.clientState.accountChanged.subscribe(binding, {
      onStarted: snapshots.request,
      onData: (event) => {
        if (event.section === 'assistantSessions') {
          if (active) void utils.account.listAssistantSessions.invalidate();
          return;
        }
        if (event.section === 'reads') {
          void utils.account.listAssistantSessions.invalidate();
          void utils.account.listAgentLabPersonas.invalidate();
          void utils.account.listAgentLabGroups.invalidate();
          void utils.account.listOfficialAccounts.invalidate();
          void utils.account.listServiceAccounts.invalidate();
          void utils.account.guildDirectListSessions.invalidate();
        }
        if (event.section === 'drafts') {
          window.dispatchEvent(new Event('weq-shared-drafts'));
          void utils.account.listDrafts.invalidate();
          void utils.mergeForward.workspaceDrafts.invalidate();
          void utils.mergeForward.archiveList.invalidate();
          void utils.account.listAssistantSessions.invalidate();
          if (event.draftKey?.startsWith('virtual:clone:persona:'))
            void utils.account.listAgentLabPersonas.invalidate();
          if (event.draftKey?.startsWith('virtual:clone:group:'))
            void utils.account.listAgentLabGroups.invalidate();
        } else snapshots.request();
      },
    });
    return () => {
      active = false;
      snapshots.dispose();
      sub.unsubscribe();
      bindAccountState(null);
    };
  }, [uin, configId, utils]);
  const error = saveError || (!checkingWorkspace && readFailed ? '共享设置读取失败' : '');
  if (!error) return null;
  return (
    <div role="status" className="weq-sync-status">
      <span>{error}</span>
      <button
        type="button"
        onClick={() => {
          if (saveError) retryPreferences();
          refreshPreferences.current?.();
        }}
      >
        <RefreshCw size={14} />
        重试
      </button>
      <button
        type="button"
        className="weq-sync-status-close"
        aria-label="关闭提示"
        title="关闭提示"
        onClick={() => {
          setReadFailed(false);
          if (saveError) useClientPreferences.setState({ error: '' });
        }}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
