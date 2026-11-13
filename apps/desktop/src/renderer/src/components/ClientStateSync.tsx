import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import {
  acceptAccountState,
  acceptPreferences,
  bindAccountState,
  initializePreferences,
  migrateAccountState,
  retryPreferences,
  useClientPreferences,
} from '../lib/clientPreferences';

/** 应用只保留一份订阅；消息与首屏无需等待同步服务。 */
export function ClientStateSync() {
  const utils = trpc.useUtils();
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const error = useClientPreferences((state) => state.error);
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void initializePreferences().catch((error) => {
        if (active) useClientPreferences.setState({ error: `共享设置读取失败：${String(error)}` });
      });
      void utils.bootstrap.getSettings.invalidate();
    };
    refresh();
    const sub = client.clientState.changed.subscribe(undefined, {
      onStarted: refresh,
      onData: () => {
        void client.clientState.snapshot
          .query()
          .then((snapshot) => {
            if (active) acceptPreferences(snapshot);
          })
          .catch(() => {});
        void utils.bootstrap.getSettings.invalidate();
        void utils.bootstrap.getDefaultVisionModel.invalidate();
        void utils.settings.invalidate();
        void utils.account.intentSense.getStatus.invalidate();
        void utils.account.antiRecall.getStatus.invalidate();
        void utils.account.getAssistantConfig.invalidate();
        void utils.account.getAccountConfig.invalidate();
        void utils.account.dressup.getState.invalidate();
        void utils.account.annualReport.getManifest.invalidate();
        void utils.mail.preferences.invalidate();
      },
    });
    return () => {
      active = false;
      sub.unsubscribe();
    };
  }, [utils]);
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
    const refresh = () =>
      void client.clientState.accountSnapshot
        .query(binding)
        .then(async (snapshot) => {
          if (active) {
            acceptAccountState(snapshot, binding);
            await migrateAccountState(binding);
          }
        })
        .catch(() => {});
    refresh();
    const sub = client.clientState.accountChanged.subscribe(binding, {
      onStarted: refresh,
      onData: (event) => {
        if (event.section === 'drafts') {
          window.dispatchEvent(new Event('weq-shared-drafts'));
          void utils.account.listDrafts.invalidate();
          void utils.mergeForward.workspaceDrafts.invalidate();
          void utils.mergeForward.archiveList.invalidate();
          void utils.clientState.draftCopies.invalidate();
          void utils.account.listAssistantSessions.invalidate();
        } else refresh();
      },
    });
    return () => {
      active = false;
      sub.unsubscribe();
      bindAccountState(null);
    };
  }, [uin, configId, utils]);
  if (!error) return null;
  return (
    <div role="status" className="weq-sync-status">
      <span>{error}</span>
      <button
        type="button"
        title="重试保存与读取"
        onClick={() => {
          retryPreferences();
          void initializePreferences().catch(() => {});
        }}
      >
        <RefreshCw size={14} />
        重试
      </button>
    </div>
  );
}
