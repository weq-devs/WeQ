import { useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { client } from '../../trpc/client';
import { ExportSaveActions } from '../ExportSaveActions';
import { ServerSavePrompt } from '../ServerSavePrompt';
import { useToast } from '../Toast';
import { ActionIcon } from './shared';

export function FavoriteBundleExport({
  binding,
  disabled,
}: {
  binding: QQWriteBinding | null;
  disabled: boolean;
}) {
  const save = useExportSavePolicy();
  const push = useToast((state) => state.push);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const matches =
    binding &&
    binding.expectedAccountUin === save.binding?.expectedAccountUin &&
    binding.expectedAccountConfigId === save.binding?.expectedAccountConfigId;
  const unavailable = disabled || pending || !matches || save.settings.isLoading;
  async function run(intent?: ExportSavePolicy) {
    if (unavailable || inFlight.current || !binding) return;
    inFlight.current = true;
    setPending(true);
    try {
      const selected = { ...binding };
      const policy = await save.prepareSave(intent, {
        kind: 'file',
        name: '收藏表情',
        format: 'zip',
      });
      if (!policy || !save.isCurrent()) return;
      await client.account.qqActions.favoriteExport.mutate({ ...selected, savePolicy: policy });
      if (save.isCurrent()) push({ tone: 'info', title: '收藏表情导出任务已创建' });
    } catch (error) {
      if (save.isCurrent())
        push({
          tone: 'error',
          title: '收藏表情导出失败',
          detail: error instanceof Error ? error.message : String(error),
        });
    } finally {
      inFlight.current = false;
      if (save.isCurrent()) setPending(false);
    }
  }
  return (
    <>
      <ActionIcon
        label={pending ? '正在准备收藏包导出' : '导出收藏表情包'}
        disabled={unavailable}
        onClick={() => void run()}
      >
        {pending ? <Loader2 size={16} /> : <Download size={16} />}
      </ActionIcon>
      <ExportSaveActions disabled={unavailable} onSelect={(policy) => void run(policy)} />
      {save.serverLocation && (
        <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
      )}
    </>
  );
}
