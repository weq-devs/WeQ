import { useState } from 'react';
import { client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useToast } from '../../components/Toast';
import { ExportLightbox, type LightboxResult } from './ExportLightbox';
import { preflightQqOnline } from './preflight';

export function QzoneExportLightbox({
  target,
  onClose,
}: {
  target: { uin: string; name: string };
  onClose: () => void;
}) {
  const dialog = useAppDialog();
  const toast = useToast((state) => state.push);
  const [busy, setBusy] = useState(false);
  async function start(result: LightboxResult) {
    if (!(await preflightQqOnline(dialog))) return;
    setBusy(true);
    try {
      const formats = result.formats.filter((format): format is 'json' | 'txt' | 'html' =>
        ['json', 'txt', 'html'].includes(format),
      );
      await client.account.startQzoneExport.mutate({
        targetUin: target.uin,
        name: target.name,
        format: formats[0] ?? 'json',
        formats,
        includeInteraction: result.options.qzoneInteractions || formats.includes('html'),
        downloadMedia: result.options.exportMedia || formats.includes('html'),
        range: { start: result.options.range.start, end: result.options.range.end },
      });
      toast({
        tone: 'success',
        title: '空间导出任务已开始',
        detail: '可在导出中心查看进度并保存结果。',
      });
      onClose();
    } catch (error) {
      dialog.error('启动空间导出失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ExportLightbox
      variant="qzone"
      headline={`导出「${target.name}」的说说`}
      summary="QQ 空间"
      submitting={busy}
      onClose={onClose}
      onConfirm={(result) => void start(result)}
      autoSaveHint="任务进度与导出结果见导出中心。"
    />
  );
}
