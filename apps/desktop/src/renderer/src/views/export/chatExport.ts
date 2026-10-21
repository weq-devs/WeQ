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
  ocrReadiness,
  preflightOcrImages,
  preflightVoiceTranscribe,
  preflightOnlineTranscribe,
} from './preflight';
import type { ExportFormat, ExportOptions } from './types';
import type { ExportSavePolicy } from '@weq/service';

/** 一个导出目标会话（导出中心的选择项 / 聊天页当前会话）。 */
export interface ChatExportTarget {
  id: string;
  name: string;
  kind?: 'group' | 'c2c';
  total?: number;
  messageIds?: string[];
}

/** 灯箱选项 → `account.startExport` 的 media 入参（媒体子选项只在导出媒体时生效）。 */
export function buildChatExportMedia(
  options: ExportOptions,
  opts: { messageCompletion?: boolean; ocrPrefilter?: boolean } = {},
): {
  exportMedia: boolean;
  completeMessages: boolean;
  completeMedia: boolean;
  downloadVideo: boolean;
  downloadFile: boolean;
  downloadPtt: boolean;
  transcribeVoice: boolean;
  onlineTranscribe: boolean;
  onlineConcurrency: number;
  ocrImages: boolean;
  onlineOcr: boolean;
  onlineOcrConcurrency: number;
  ocrPrefilter: boolean;
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
    // 在线转写依附于「语音转写」；未开语音转写时强制关闭。
    onlineTranscribe: options.transcribeVoice && options.onlineTranscribe,
    onlineConcurrency: options.onlineConcurrency,
    ocrImages: options.ocrImages,
    // 在线识别依附于「图片文字识别」；未开 OCR 时强制关闭。
    onlineOcr: options.ocrImages && options.onlineOcr,
    onlineOcrConcurrency: options.ocrConcurrency,
    // 筛图模型没下好就跳过预筛选阶段（灯箱 / 设置里都能下）。
    ocrPrefilter: options.ocrImages && opts.ocrPrefilter === true,
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

  if (media.ocrImages) {
    const ok = await preflightOcrImages(dialog);
    if (!ok) return false;
  }

  // 在线转录必须已经 arm（灯箱点开关时 arm）；否则硬拦截。
  if (media.onlineTranscribe) {
    const ok = await preflightOnlineTranscribe(dialog);
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
  opts: {
    messageCompletion?: boolean;
    savePolicy?: ExportSavePolicy;
    binding?: { expectedAccountUin: string; expectedAccountConfigId: string };
    isCurrent?: () => boolean;
  } = {},
): Promise<string[]> {
  const frozenTargets = targets.map((target) => ({
    ...target,
    ...(target.messageIds ? { messageIds: [...target.messageIds] } : {}),
  }));
  const frozenOptions = structuredClone(options);
  const frozenFormats = [...formats];
  const binding = opts.binding ? { ...opts.binding } : undefined;
  const savePolicy = opts.savePolicy ? { ...opts.savePolicy } : undefined;
  const current = opts.isCurrent;
  const messageCompletion = opts.messageCompletion;
  const fmt0 = frozenFormats[0] ?? defaultFormat;
  // 筛图模型的状态是**实时**的（不进持久化预设）：导出那一刻下好了就筛，没下好就跳过。
  const ocrPrefilter = frozenOptions.ocrImages ? (await ocrReadiness()).filterReady : false;
  const media = buildChatExportMedia(frozenOptions, { messageCompletion, ocrPrefilter });
  const range = { start: frozenOptions.range.start, end: frozenOptions.range.end };
  const ids: string[] = [];
  for (const t of frozenTargets) {
    if (current && !current())
      throw new Error(`已创建 ${ids.length} 个任务；账号数据源已切换，已停止后续任务。`);
    const id = await client.account.startExport.mutate({
      ...binding,
      savePolicy,
      kind: t.kind ?? 'c2c',
      conv: t.id,
      name: t.name,
      format: fmt0 as Exclude<ExportFormat, 'vcard'>,
      formats: frozenFormats as Exclude<ExportFormat, 'vcard'>[],
      total: t.total ?? 0,
      exportAvatar: frozenOptions.exportAvatar,
      ...(frozenOptions.dress.bubble || frozenOptions.dress.font || frozenOptions.dress.widget
        ? { dress: frozenOptions.dress }
        : {}),
      ...(frozenOptions.chatlab ? { chatlab: true } : {}),
      media,
      ...(t.messageIds ? { filter: { messageIds: [...t.messageIds] } } : { range }),
    });
    ids.push(id);
  }
  return ids;
}
