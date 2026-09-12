/**
 * 聊天页「快捷导出」灯箱。
 *
 * 把导出中心「聊天消息导出」的 {@link ExportLightbox} 原样搬到聊天顶栏：目标会话
 * 固定为当前会话（不用再在导出页里勾一遍），确认后直接建任务，进度去导出中心
 * 的任务栏看。灯箱里的格式 / 时间范围 / 媒体 / 补全选项与导出页完全一致，前置
 * 检查也走同一套 `preflightChatExport`，只有「导出后自动保存」换成一句提示 ——
 * 那个能力依赖导出页的任务列表。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ExportPresets } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useToast } from '../../components/Toast';
import { ExportLightbox, type LightboxResult } from './ExportLightbox';
import { preflightChatExport, startChatExportTasks } from './chatExport';
import { DEFAULT_OPTIONS, fmtCount } from './types';

/** 快捷导出的目标会话（聊天顶栏当前会话）。 */
export interface QuickExportTarget {
  id: string;
  name: string;
  kind: 'group' | 'c2c';
}

/** 最近会话 wire —— 这里只读消息计数（与导出页同一 query）。 */
interface ConvCountWire {
  targetUid: string;
  messageCount?: number;
}

export function QuickExportLightbox({
  target,
  onClose,
}: {
  target: QuickExportTarget;
  onClose: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const pushToast = useToast((s) => s.push);
  const [submitting, setSubmitting] = useState(false);
  /** 导出页记住的灯箱配置：两条入口的默认勾选保持一致。 */
  const [presets, setPresets] = useState<ExportPresets | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.bootstrap.getExportPresets
      .query()
      .then((p) => {
        if (!cancelled) setPresets(p);
      })
      .catch(() => {
        // 读不到缓存就按默认配置打开，不影响导出。
        if (!cancelled) setPresets({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 任务进度的分母 = 本地消息条数（与导出页取数一致）。
  const conversations = trpc.account.listConversationsWithCount.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const total = useMemo(() => {
    const rows = (conversations.data ?? []) as ConvCountWire[];
    return Number(rows.find((c) => c.targetUid === target.id)?.messageCount ?? 0);
  }, [conversations.data, target.id]);

  const initialOptions = useMemo(
    // 快捷模式下没有导出页的任务列表，自动保存开关无意义 —— 关掉兜底。
    () => ({ ...(presets?.full?.options ?? DEFAULT_OPTIONS), autoSave: false }),
    [presets],
  );

  async function onConfirm(result: LightboxResult): Promise<void> {
    const ok = await preflightChatExport(dialog, result.options);
    if (!ok) return;
    setSubmitting(true);
    try {
      await startChatExportTasks(
        [{ id: target.id, name: target.name, kind: target.kind, total }],
        result.options,
        result.formats,
        'json',
      );
      // 与导出页共享最近一次灯箱配置（下次打开回填）。
      void client.bootstrap.setExportPreset
        .mutate({ variant: 'full', formats: result.formats, options: result.options })
        .catch(() => undefined);
      onClose();
      pushToast({
        tone: 'success',
        title: '导出任务已开始',
        detail: `「${target.name}」正在导出，可前往「导出中心」的任务栏查看进度。`,
      });
    } catch (e) {
      dialog.error('启动导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const kindLabel = target.kind === 'group' ? '群聊' : '私聊';
  return (
    <ExportLightbox
      variant="full"
      headline={`导出「${target.name}」`}
      summary={`${kindLabel} · ${fmtCount(total)} 条`}
      initialOptions={initialOptions}
      initialFormats={presets?.full?.formats}
      submitting={submitting}
      autoSaveHint="「导出后自动保存」在导出中心可用；这里开始后请到任务栏手动保存。"
      onClose={onClose}
      onConfirm={(result) => void onConfirm(result)}
    />
  );
}
