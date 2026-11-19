/**
 * 导出任务中心（重构版）。
 *
 * 顶部一排任务小卡片：图标 + 名称 + 波浪总进度（不显示百分比），点击切换
 * 下方展示哪个任务的详情；默认选中第一个任务。
 *
 * 详情区展示该任务的每个子任务进度条（右侧只显示百分比，不显示进度名称），
 * 每个子任务进度条下方挂自己的滚动日志（Docker TUI 风格）；子任务完成后日志
 * 自动收起，仍可手动展开。任务级日志（扫描摘要 / 起止 / 错误）固定在详情
 * 底部，任务完成后也可展开查看。
 */

import type { ReactElement } from 'react';
import {
  Bookmark,
  Contact,
  Globe,
  FolderOpen,
  Sticker,
  Users,
  UserRound,
  MessagesSquare,
} from 'lucide-react';
import { exportTaskDisplay, taskDisplayTitle, type TaskDisplay } from '@weq/service/task-display';
import '../../styles/chat-export-continuation.css';

export type StageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

/** One failed media file, surfaced from a stage's `failures`. */
export interface UiFailure {
  stage: string;
  fileName: string;
  error: string;
}

export interface UiStage {
  key: string;
  label: string;
  status: StageStatus;
  current: number;
  total: number;
  failed?: number;
  note?: string;
  failures?: UiFailure[];
}

/** 一行任务日志（后端 ExportTaskManager 环形缓冲下发）。 */
export interface UiLogLine {
  ts: number;
  seq: number;
  stage: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}
export const SKIPPABLE_STAGE_KEYS = [
  'backfill',
  'dress',
  'avatar',
  'media',
  'image',
  'video',
  'file',
  'ptt',
  'transcribe',
  'ocrfilter',
  'ocr',
  'sysface',
] as const;

export interface UiTask {
  display?: TaskDisplay;
  createdAt?: number;
  databaseRecovery?: import('@weq/service').ExportTask['databaseRecovery'];
  databaseRecoveryRecords?: import('@weq/service').ExportTask['databaseRecoveryRecords'];
  networkPaused?: boolean;
  resource?: import('@weq/service').ExportTask['resource'];
  save?: import('@weq/service').ExportSaveState;
  canResume?: boolean;
  journalPath?: string;
  canIncremental?: boolean;
  canFinalize?: boolean;
  resourceOnly?: boolean;
  partialReady?: boolean;
  isFinalizing?: boolean;
  mergeWarnings?: import('@weq/service').ExportTask['mergeWarnings'];
  resumeMode?: 'checkpoint' | 'restart';
  reportPath?: string;
  id: string;
  kind: import('@weq/service').ExportTask['kind'];
  name: string;
  format: string;
  /** 多格式导出（同一任务多文件；缺省 = [format]）。 */
  formats?: string[];
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  current: number;
  total: number;
  error?: string;
  filePath?: string;
  /** Set when the output is an avatar bundle folder (saved as a folder). */
  bundleDir?: string;
  /** Number of sender avatars exported into the bundle. */
  avatarCount?: number;
  /** Per-stage progress (backfill → dress → message → media → record → image …). */
  stages?: UiStage[];
  /** 每子任务的滚动日志（后端下发）。 */
  logs?: UiLogLine[];
  /** 商城表情批量下载任务：隐藏格式标签、计数单位用「张」而非「条」。 */
  isMarketPack?: boolean;
  /** 导出表情包任务：隐藏格式标签、计数单位用「张」。 */
  isEmojiPack?: boolean;
  /** QQ 空间导出（图标 / 类型标签用）。 */
  isQzone?: boolean;
  /** 联系人导出。 */
  isContacts?: boolean;
  /** 收藏导出。 */
  isCollection?: boolean;
  /** 频道私聊导出（guild_msg.db；无漫游消息）。 */
  isGuild?: boolean;
  isGenerated?: boolean;
  canPause?: boolean;
  generatedResources?: { total: number; copied: number; missing: number };
}

export function isResourceDownload(t: UiTask): boolean {
  return Boolean(
    t.resource &&
      [
        'group-files',
        'group-albums',
        'qzone-albums',
        'media',
        'mail-attachment',
        'market-image',
        'decoration',
      ].includes(t.resource.kind),
  );
}

export function taskCanPause(t: UiTask): boolean {
  return t.canPause ?? !t.resource;
}

export function taskResumeActionLabel(t: UiTask): string {
  if (t.status === 'completed') return '补传已跳过项目';
  if (t.resumeMode === 'restart') {
    if (isResourceDownload(t)) return '重新下载';
    return t.resource ? '重新执行' : '重新执行导出';
  }
  return t.isMarketPack || isResourceDownload(t) ? '继续下载' : '继续导出';
}

export function taskCancelActionLabel(t: UiTask): string {
  return isResourceDownload(t) ? '取消下载' : '取消';
}

/** 卡片波浪总进度（完成 100；排队 0）。 */
export function taskPct(t: UiTask): number {
  if (t.status === 'completed') return 100;
  if (t.status === 'pending') return 0;
  return Math.min(100, Math.max(0, Math.round(t.progress)));
}

/** 任务类型标签（卡片 title / 详情 meta）。 */
export function taskTypeLabel(t: UiTask): string {
  if (t.display?.category) return t.display.category;
  if (t.resourceOnly) return '聊天资源';
  if (t.resource?.kind === 'database') return '明文数据库';
  if (t.resource?.kind === 'assistant-artifact') return '助手报告';
  if (t.resource?.kind === 'market-image') return '商城单张表情';
  if (t.resource?.kind === 'mail-attachment') return '邮件附件';
  if (t.resource?.kind === 'mail-messages') return '邮件';
  if (t.resource?.kind === 'decoration') return '装扮素材';
  if (t.resource?.kind === 'qzone-albums') return 'QQ 空间相册';
  if (t.resource?.kind === 'favorite-emoji') return '收藏表情';
  if (t.resource?.kind === 'annual-report') return '年度报告';
  if (t.resource?.kind === 'analytics-report') return '分析长图';
  if (t.resource?.kind === 'persona-bot') return '克隆机器人';
  if (t.resource?.kind === 'media') return '媒体文件';
  if (t.resource?.kind === 'composition') return '合成聊天记录';
  if (t.resource?.kind === 'group-albums') return '群相册';
  if (t.resource?.kind === 'group-files') return '群文件';
  if (t.resource) return '资源';
  if (t.isMarketPack) return '商城表情包';
  if (t.isEmojiPack) return '表情图片';
  if (t.isQzone) return 'QQ 空间';
  if (t.isContacts) return '联系人名单';
  if (t.isCollection) return '收藏';
  if (t.isGuild) return '频道私聊';
  if (t.isGenerated) return '本地生成对话';
  return { group: '群聊', c2c: '私聊', official: '官方号', service: '服务号' }[t.kind] ?? '会话';
}

export function taskTitle(t: UiTask): string {
  return taskDisplayTitle(exportTaskDisplay(t));
}

/** 任务类型图标（消息 / 联系人 / QQ 空间 / 收藏 / 商城表情）。 */
export function taskIcon(t: UiTask): ReactElement {
  if (t.resource?.kind === 'composition') return <MessagesSquare size={15} />;
  if (t.resource) return <FolderOpen size={15} />;
  if (t.isMarketPack) return <Sticker size={15} />;
  if (t.isEmojiPack) return <Sticker size={15} />;
  if (t.isQzone) return <Globe size={15} />;
  if (t.isContacts) return <Contact size={15} />;
  if (t.isCollection) return <Bookmark size={15} />;
  return t.kind === 'group' ? <Users size={15} /> : <UserRound size={15} />;
}

/** 自动保存中的任务不重复提供手动入口，旧版未保存结果仍可取回。 */
export function taskSaveActionLabel(task: UiTask): string | null {
  if (task.status === 'completed') {
    if (task.save?.status === 'failed' || task.save?.status === 'interrupted') return '重试保存';
    if (
      !task.save ||
      (task.save.status === 'pending' &&
        !task.save.policy?.directory &&
        !task.save.policy?.filePath)
    )
      return '保存结果';
    return null;
  }
  return task.status === 'paused' && task.partialReady && task.canResume && task.filePath
    ? '保存现有进度'
    : null;
}
