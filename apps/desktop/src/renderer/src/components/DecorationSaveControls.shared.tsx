import { useRef, useState } from 'react';
import type { ExportSavePolicy } from '@weq/service';
import { client } from '../trpc/client';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { IS_WEB } from '../lib/target.shared';
import { ServerSavePrompt } from './ServerSavePrompt';
import { useToast } from './Toast.shared';
import { notifyTaskCreated } from '../lib/taskNotifications';
import '../styles/decoration-save.css';

interface DecorationSaveInput {
  bubbleId: number;
  fontId: number;
  widgetId: number;
  kind?: 'font' | 'bubble' | 'widget';
}

/** 每个装扮面板共用一份保存准备与在途锁，不为每个商城条目创建查询观察者。 */
export function useDecorationSave() {
  const developmentDressTools = useDevelopmentDressTools();
  const save = useExportSavePolicy();
  const pushToast = useToast((state) => state.push);
  const identity = `${save.binding?.expectedAccountUin}:${save.binding?.expectedAccountConfigId}`;
  const pending = useRef<string | null>(null);
  const [operation, setOperation] = useState<{ identity: string; key: string } | null>(null);
  async function run(
    input: DecorationSaveInput,
    key: string,
    intent?: ExportSavePolicy,
    browser = false,
  ) {
    if (!developmentDressTools) return;
    if (!save.binding || pending.current === identity || save.settings.isLoading) return;
    const selected = { ...input, ...save.binding };
    pending.current = identity;
    setOperation({ identity, key });
    try {
      // Web 只选服务器目录；桌面文件框由主进程根据实际 PNG/TTF/ZIP 产物打开。
      const policy = browser
        ? undefined
        : IS_WEB
          ? await save.prepareSave(intent, { kind: 'bundle', name: '装扮资源' })
          : save.policy;
      if ((!browser && !policy) || !save.isCurrent()) return;
      const result = await client.account.dressup.saveMsgDecoration.mutate({
        ...selected,
        savePolicy: policy ?? undefined,
        browserDownload: browser,
      });
      if (!save.isCurrent() || result.mode === 'cancelled') return;
      if (result.mode === 'browser') {
        if (!result.downloadId) throw new Error('浏览器下载未返回文件标识');
        const link = document.createElement('a');
        link.href = `/_download/${encodeURIComponent(result.downloadId)}`;
        link.download = result.name;
        link.click();
      } else notifyTaskCreated(result.taskId, '正在保存装扮');
    } catch (error) {
      if (save.isCurrent())
        pushToast({
          tone: 'error',
          title: '装扮保存失败',
          detail: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pending.current === identity) pending.current = null;
      setOperation((previous) => (previous?.identity === identity ? null : previous));
    }
  }
  return {
    run,
    savingKey: operation?.identity === identity ? operation.key : '',
    disabled:
      !developmentDressTools ||
      !save.binding ||
      save.settings.isLoading ||
      operation?.identity === identity,
    prompt: save.serverLocation ? (
      <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
    ) : null,
  };
}
