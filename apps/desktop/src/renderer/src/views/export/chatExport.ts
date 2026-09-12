/**
 * 聊天消息导出的共用启动逻辑 —— 导出中心（ExportView）与聊天顶栏快捷导出
 * 灯箱共用同一套媒体选项映射、前置检查与任务创建，避免两条入口的导出参数
 * 漂移。
 */

import type { AppDialogApi } from '../../lib/dialogUtils';
import { client } from '../../trpc/client';
import {
  preflightMediaCompletion,
  preflightMessageCompletion,
  preflightVoiceTranscribe,
} from './preflight';
import type { ExportFormat, ExportOptions } from './types';

/** 一个导出目标会话（导出中心的选择项 / 聊天页当前会话）。 */
export interface ChatExportTarget {
  id: string;
  name: string;
  kind?: 'group' | 'c2c';
  total?: number;
}

/** 灯箱选项 → `account.startExport` 的 media 入参（媒体子选项只在导出媒体时生效）。 */
export function buildChatExportMedia(
  options: ExportOptions,
  opts: { messageCompletion?: boolean } = {},
): {
  exportMedia: boolean;
  completeMessages: boolean;
  completeMedia: boolean;
  downloadVideo: boolean;
  downloadFile: boolean;
  downloadPtt: boolean;
  transcribeVoice: boolean;
  mediaKinds: ExportOptions['mediaKinds'] | undefined;
  completeDress: boolean;
} {
  // 频道私聊（guild）没有漫游缓存可拉，补全消息恒关闭。
  const messageCompletion = opts.messageCompletion ?? true;
  return {
    exportMedia: options.exportMedia,
    completeMessages: messageCompletion && options.completeMessages,
    completeMedia: options.exportMedia && options.completeMedia,
    downloadVideo: options.exportMedia && options.downloadVideo,
    downloadFile: options.exportMedia && options.downloadFile,
    downloadPtt: options.exportMedia && options.downloadPtt,
    transcribeVoice: options.transcribeVoice,
    mediaKinds: options.exportMedia ? options.mediaKinds : undefined,
    completeDress: options.completeDress,
  };
}

/**
 * 聊天消息 / 频道私聊导出的前置检查：补全消息 → 媒体补全（含「未开启媒体补全」
 * 的确认）→ 语音转写。返回 false 表示用户取消或条件不满足，调用方应中止导出。
 */
export async function preflightChatExport(
  dialog: AppDialogApi,
  options: ExportOptions,
  opts: { messageCompletion?: boolean } = {},
): Promise<boolean> {
  const media = buildChatExportMedia(options, opts);
  if (media.completeMessages) {
    const ok = await preflightMessageCompletion(dialog);
    if (!ok) return false;
  }

  if (media.completeMedia || media.downloadVideo || media.downloadFile || media.downloadPtt) {
    const ok = await preflightMediaCompletion(dialog);
    if (!ok) return false;
  } else if (media.exportMedia) {
    const ok = await dialog.confirm(
      '未开启媒体补全',
      '已开启「导出媒体文件」但未开启「补全缺失媒体」。本地缓存中缺失的图片 / 视频 / 文件不会从云端下载，可能有大量媒体无法导出。是否继续？',
      { okLabel: '继续导出', cancelLabel: '返回', tone: 'warning' },
    );
    if (!ok) return false;
  }

  if (media.transcribeVoice) {
    const ok = await preflightVoiceTranscribe(dialog);
    if (!ok) return false;
  }
  return true;
}

/**
 * 为每个目标会话创建一个导出任务（多格式合并进同一任务：所有格式写进同一
 * bundle，媒体 / 头像 / 装扮只带一份）。返回创建出的任务 id，供调用方决定
 * 「导出后自动保存」等后续动作。
 */
export async function startChatExportTasks(
  targets: readonly ChatExportTarget[],
  options: ExportOptions,
  formats: readonly ExportFormat[],
  defaultFormat: ExportFormat,
  opts: { messageCompletion?: boolean } = {},
): Promise<string[]> {
  const fmt0 = formats[0] ?? defaultFormat;
  const media = buildChatExportMedia(options, opts);
  const range = { start: options.range.start, end: options.range.end };
  const ids: string[] = [];
  for (const t of targets) {
    const id = await client.account.startExport.mutate({
      kind: t.kind ?? 'c2c',
      conv: t.id,
      name: t.name,
      format: fmt0 as Exclude<ExportFormat, 'vcard'>,
      formats: formats as Exclude<ExportFormat, 'vcard'>[],
      total: t.total ?? 0,
      exportAvatar: options.exportAvatar,
      ...(options.dress.bubble || options.dress.font || options.dress.widget
        ? { dress: options.dress }
        : {}),
      ...(options.chatlab ? { chatlab: true } : {}),
      media,
      range,
    });
    ids.push(id);
  }
  return ids;
}
