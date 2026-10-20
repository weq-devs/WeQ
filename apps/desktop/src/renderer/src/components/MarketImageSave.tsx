import { useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { client } from '../trpc/client';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { IS_WEB } from '../lib/target';
import { ExportSaveActions } from './ExportSaveActions';
import { ServerSavePrompt } from './ServerSavePrompt';
import { useToast } from './Toast';
import '../styles/market-image-save.css';

export function MarketImageSave({
  packId,
  hash,
  name,
}: {
  packId: string;
  hash: string;
  name: string;
}) {
  const save = useExportSavePolicy();
  const pushToast = useToast((state) => state.push);
  const identity = `${save.binding?.expectedAccountUin}:${save.binding?.expectedAccountConfigId}:${packId}:${hash}`;
  const pending = useRef<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const busy = operation === identity;
  async function start(intent?: ExportSavePolicy, browser = false) {
    if (pending.current === identity || !save.binding) return;
    pending.current = identity;
    setOperation(identity);
    const selected = { ...save.binding, packId, hash, name };
    try {
      if (browser) {
        const result = await client.account.marketEmoji.downloadImage.mutate(selected);
        if (!save.isCurrent()) return;
        const link = document.createElement('a');
        link.href = result.url;
        link.download = '';
        link.click();
      } else {
        const policy = await save.prepareSave(intent, { kind: 'file', name, format: 'gif' });
        if (!policy || !save.isCurrent()) return;
        await client.account.marketEmoji.startImageSave.mutate({ ...selected, savePolicy: policy });
        if (save.isCurrent())
          pushToast({
            tone: 'info',
            title: '单张表情保存任务已创建',
            message: '可在导出任务列表查看结果与保存位置',
          });
      }
    } catch (error) {
      if (save.isCurrent())
        pushToast({
          tone: 'error',
          title: '表情保存失败',
          detail: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pending.current === identity) pending.current = null;
      setOperation((previous) => (previous === identity ? null : previous));
    }
  }
  const disabled = busy || !save.binding || save.settings.isLoading;
  return (
    <>
      <div className="weq-save-action-group">
        <button
          type="button"
          className="weq-mface-detail-back"
          disabled={disabled}
          onClick={() => void start()}
          title={IS_WEB ? '保存到服务器' : '保存表情'}
          aria-label={IS_WEB ? '保存到服务器' : '保存表情'}
        >
          {busy ? <Loader2 size={15} className="weq-spin" /> : <Download size={15} />}
          {IS_WEB ? '保存到服务器' : '保存'}
        </button>
        <ExportSaveActions disabled={disabled} onSelect={(intent) => void start(intent)} />
        {IS_WEB && (
          <button
            type="button"
            className="weq-mface-detail-copy"
            aria-label="下载到浏览器"
            title="下载到浏览器"
            disabled={disabled}
            onClick={() => void start(undefined, true)}
          >
            <Download size={15} />
          </button>
        )}
      </div>
      {save.serverLocation && (
        <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
      )}
    </>
  );
}
