import { useRef, useState } from 'react';
import { ServerSavePrompt } from '../components/ServerSavePrompt';
import { useAppDialog } from '../lib/dialogUtils';
import { IS_WEB } from '../lib/target.shared';
import { rememberTaskCreated } from '../lib/taskNotifications';
import { client, trpc } from '../trpc/client';
import { useExportSavePolicy } from './useExportSavePolicy';

type DownloadInput = Parameters<typeof client.account.dressup.download.mutate>[0];

export function useDressDownload() {
  const save = useExportSavePolicy();
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const pending = useRef(false);
  const [savingKey, setSavingKey] = useState('');

  async function run(kind: DownloadInput['kind'], items: DownloadInput['items'], key: string) {
    if (!save.binding || save.settings.isLoading || pending.current || !items.length) return false;
    pending.current = true;
    setSavingKey(key);
    try {
      const policy = IS_WEB
        ? await save.prepareSave(undefined, { kind: 'bundle', name: '装扮下载' })
        : save.policy;
      if (!policy || !save.isCurrent()) return false;
      const taskId = await client.account.dressup.download.mutate({
        ...save.binding,
        kind,
        items,
        savePolicy: policy,
      });
      if (!taskId || !save.isCurrent()) return false;
      rememberTaskCreated(taskId);
      void utils.account.listExportTasks.invalidate().catch(() => {});
      return true;
    } catch (error) {
      if (save.isCurrent())
        dialog.error(
          '创建装扮下载任务失败',
          error instanceof Error ? error.message : String(error),
        );
      return false;
    } finally {
      pending.current = false;
      setSavingKey('');
    }
  }

  return {
    run,
    savingKey,
    disabled: !save.binding || save.settings.isLoading || Boolean(savingKey),
    prompt: save.serverLocation ? (
      <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
    ) : null,
  };
}
