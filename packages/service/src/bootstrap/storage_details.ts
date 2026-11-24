import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageUsageItem } from './storage_usage';

type Detail = {
  label: string;
  category: NonNullable<StorageUsageItem['category']>;
  layout?: Layout;
  confirmation?: string;
  exitOnly?: boolean;
};

type Layout = {
  labels: Readonly<Record<string, string>>;
  lookupLabel?: (name: string) => string | undefined;
  confirmations?: Readonly<Record<string, string>>;
  lookupConfirmation?: (name: string) => string | undefined;
  children?: Readonly<Record<string, Layout>>;
  session?: { name: RegExp; layout: Layout; showName?: boolean };
  remainder: string;
  remainderConfirmation?: string;
};

export const CACHE_LABELS: Readonly<Record<string, string>> = {
  avatar: '头像缓存',
  media: '图片与视频缓存',
  marketface: '商城表情缓存',
  marketpack: '商城表情包缓存',
  voice: '语音缓存',
  linkpreview: '链接预览缓存',
  sysemoji: '系统表情缓存',
  'favorite-emoji': '收藏表情原图缓存',
  collection: '收藏媒体缓存',
  gift: '群礼物图片缓存',
  qqshow: 'QQ 秀资源缓存',
  redpack: '红包封面缓存',
  dress_shared: '共享装扮资源缓存',
};

/** 桌面可以重新生成的文件，和登录状态、界面设置分开。 */
export const RUNTIME_CACHE_NAMES: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
]);

const APP_DETAILS: Readonly<Record<string, Detail>> = {
  DatabaseValidation: {
    label: '数据库验证数据',
    category: 'database-validation',
    confirmation: '将删除所选验证文件，之后可能无法复核这次检查或恢复所保存的副本。',
    layout: {
      labels: {},
      session: {
        name: /^\d{8}-\d{6}$/,
        showName: true,
        layout: {
          labels: {
            backup: '数据库备份（检查前）',
            working: '数据库副本（检查用）',
            candidates: '数据库副本（试修结果）',
            scratch: '数据库检查临时文件',
            reports: '数据库检查报告',
            logs: '数据库检查日志',
            'logs-coverage': '数据库复核日志',
            native: '检查工具文件',
            'native-coverage': '复核工具文件',
            'manifest.json': '验证清单',
          },
          confirmations: {
            backup:
              '将删除为验证保留的数据库备份，之后无法从这份副本取回当时的数据。QQ 当前数据库会保留。',
            working: '将删除当时用于检查的数据库副本。验证备份和 QQ 当前数据库会保留。',
            candidates:
              '将删除试修生成的数据库副本，之后无法复核或使用这些结果。QQ 当前数据库会保留。',
          },
          remainder: '其他验证会话文件',
        },
      },
      remainder: '其他数据库验证文件',
    },
  },
  enhancements: {
    label: '增强包资源',
    category: 'app-resources',
    confirmation: '清理后相关增强功能可能暂时不可用，可在增强包中重新下载。',
    exitOnly: true,
    layout: {
      labels: {
        engines: '增强包引擎',
        'market-emoji': '商城表情目录',
        'download-tasks.json': '增强包下载任务',
        'ready.json': '增强包安装记录',
        'checks.json': '增强包更新检查记录',
      },
      remainder: '其他增强包文件',
    },
  },
  instances: {
    label: '独立窗口数据',
    category: 'desktop-data',
    confirmation: '将删除这个独立窗口保存的本地状态。再次打开时可能需要重新登录或设置。',
    exitOnly: true,
    layout: {
      labels: {},
      session: {
        name: /^[0-9a-f]{24}$/,
        layout: {
          labels: {},
          children: {
            electron: {
              labels: Object.fromEntries(
                [...RUNTIME_CACHE_NAMES].map((name) => [name, '独立窗口缓存']),
              ),
              confirmations: Object.fromEntries(
                [...RUNTIME_CACHE_NAMES].map((name) => [name, '缓存会在再次打开窗口时重新生成。']),
              ),
              remainder: '独立窗口登录与界面数据',
              remainderConfirmation: '将清除窗口的登录状态和界面偏好，再次打开可能需要重新登录。',
            },
            data: {
              labels: {
                config: '旧版账号设置',
                'config.json': '旧版全局设置',
                'client-state': '旧版界面状态',
                logs: '旧版运行日志',
                enhancements: '旧版增强包',
                announcements: '旧版公告记录',
                updates: '旧版软件更新记录',
              },
              confirmations: {
                config: '将删除旧版的账号恢复资料，以后可能无法再从旧窗口导出这些账号设置。',
                'config.json': '将删除旧版全局设置的副本，以后可能无法还原当时的设置。',
              },
              lookupLabel: (name) => {
                const detail = Object.hasOwn(BUSINESS_DETAILS, name)
                  ? BUSINESS_DETAILS[name]
                  : undefined;
                return detail && `旧版${detail.label}`;
              },
              lookupConfirmation: () => '将删除旧版窗口保存的数据，其中的历史或成果可能无法恢复。',
              children: {
                cache: {
                  labels: {
                    anti_recall: '旧版防撤回设置',
                    flash: '旧版闪传下载文件',
                  },
                  lookupLabel: (name) => {
                    const label = Object.hasOwn(CACHE_LABELS, name)
                      ? CACHE_LABELS[name]
                      : storageDetail(name, true)?.label;
                    return label && `旧版${label}`;
                  },
                  lookupConfirmation: (name) =>
                    Object.hasOwn(CACHE_LABELS, name)
                      ? '清除旧版缓存，需要时可重新下载或生成。'
                      : '将删除旧版保存的数据，相关历史或任务记录可能无法恢复。',
                  remainder: '旧版其他缓存和数据',
                },
              },
              remainder: '旧版其他窗口文件',
              remainderConfirmation: '将删除旧窗口留下的文件，其中的数据可能无法恢复。',
            },
          },
          remainder: '独立窗口运行记录',
        },
      },
      remainder: '其他独立窗口文件',
    },
  },
  'account-storage-migration.json': { label: '账号存储迁移记录', category: 'desktop-data' },
  announcements: { label: '公告数据', category: 'updates' },
  'client-state': { label: '全局界面状态', category: 'desktop-data' },
  'desktop-services': { label: '桌面后台服务数据', category: 'desktop-data' },
  'desktop-storage.sqlite': { label: '桌面存储锁', category: 'desktop-data' },
  'desktop-storage-maintenance.sqlite': { label: '桌面存储维护锁', category: 'desktop-data' },
  'settings-writes.sqlite': { label: '共享设置写入锁', category: 'desktop-data' },
  'qq-client-sync': { label: 'QQ 同步与代理状态', category: 'desktop-data' },
  'signer-cache.json': { label: 'QQ 签名器发现记录', category: 'desktop-data' },
  diagnostics: { label: '诊断文件', category: 'diagnostics' },
  logs: { label: '运行日志', category: 'diagnostics' },
  'performance-monitor': {
    label: '性能记录历史',
    category: 'diagnostics',
    confirmation: '将删除已保存的性能历史，之后会重新开始记录。',
    exitOnly: true,
  },
  'protocol-research': { label: '协议调试数据', category: 'diagnostics' },
  'storage-maintenance': { label: '空间清理记录', category: 'diagnostics' },
  models: {
    label: '离线识别与分析模型',
    category: 'app-resources',
    confirmation: '将删除已下载的本地模型，离线语音、读图或分析可能暂时不可用，需要重新下载模型。',
    exitOnly: true,
  },
  updates: { label: '软件更新索引', category: 'updates' },
};

const BUSINESS_DETAILS: Readonly<Record<string, Detail>> = {
  contacts: {
    label: '联系人信息缓存',
    category: 'account-data',
    confirmation: '将删除已记录的昵称、备注和群资料变更历史。当前联系人和群仍可继续查看。',
    exitOnly: true,
  },
  'conversation-calendar': {
    label: '会话日历统计和扫描进度',
    category: 'account-data',
    confirmation: '将删除会话日历的统计和扫描进度，下次需要重新统计。',
    exitOnly: true,
  },
  'roam-msg': { label: '已补全的漫游消息', category: 'account-data' },
  'roaming-jobs': { label: '聊天记录补全进度', category: 'account-data' },
  'collection-history': { label: '收藏历史', category: 'account-data' },
  deleted: { label: '本地删除记录', category: 'account-data' },
  export: { label: '导出文件和任务', category: 'work-products' },
  'web-exports': { label: '网页导出文件', category: 'work-products' },
  'merge-forward': { label: '合并转发草稿和归档', category: 'work-products' },
  'analysis-reports': {
    label: '已保存的分析报告',
    category: 'work-products',
    confirmation: '将删除已保存的报告和生成记录，未另存的报告可能无法恢复。',
    exitOnly: true,
  },
  'task-receipts': {
    label: '任务历史',
    category: 'work-products',
    confirmation: '将删除已保存的任务进度和回执，无法再从任务列表找回原记录。',
    exitOnly: true,
  },
  ocr: { label: '图片里的文字识别结果', category: 'search-analysis' },
  'ai-image-descriptions': {
    label: '图片理解结果',
    category: 'search-analysis',
    confirmation: '将删除已生成的图片描述，重新分析可能需要原图并产生费用。',
    exitOnly: true,
  },
  'search-index': { label: '聊天搜索索引', category: 'search-analysis' },
  'content-search': { label: '内容搜索记录', category: 'search-analysis' },
  intent_sense: { label: '意图感知结果', category: 'search-analysis' },
  agentlab: { label: '好友克隆的对话与记忆', category: 'assistant-data' },
  'weq-assistant': { label: 'WeQ 助手的对话与资料', category: 'assistant-data' },
  api_usage: { label: 'AI 用量和费用记录', category: 'assistant-data' },
  db_tolerance: { label: '数据库容错记录', category: 'diagnostics' },
  'managed-qq': { label: '托管 QQ 的聊天、媒体和登录数据', category: 'managed-qq' },
  dress: { label: '旧装扮和自定义背景', category: 'dress' },
  gift: { label: '群礼物图片缓存', category: 'media' },
};

export function storageDetail(name: string, cache: boolean): Detail | undefined {
  if (!cache && Object.hasOwn(APP_DETAILS, name)) return APP_DETAILS[name];
  return Object.hasOwn(BUSINESS_DETAILS, name) ? BUSINESS_DETAILS[name] : undefined;
}

interface StoragePart {
  path: string;
  label: string;
  excludedPaths: string[];
  confirmation?: string;
}

/** 分项和余量共用原根的排除范围，每个实际路径只交给一个分项测量。 */
export async function storageParts(
  path: string,
  layout: Layout,
  excludedPaths: string[],
  suffix = '',
): Promise<StoragePart[]> {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > 500_000) throw new Error('存储明细过多');
  const parts: StoragePart[] = [];
  const claimed = new Set(excludedPaths);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (claimed.has(child)) continue;
    const label = Object.hasOwn(layout.labels, entry.name)
      ? layout.labels[entry.name]
      : layout.lookupLabel?.(entry.name);
    if (label) {
      parts.push({
        path: child,
        label: label + suffix,
        excludedPaths,
        confirmation: layout.confirmations?.[entry.name] ?? layout.lookupConfirmation?.(entry.name),
      });
    } else {
      if (!entry.isDirectory()) continue;
      const session = layout.session?.name.test(entry.name) ? layout.session : undefined;
      const childLayout =
        session?.layout ??
        (layout.children && Object.hasOwn(layout.children, entry.name)
          ? layout.children[entry.name]
          : undefined);
      if (!childLayout) continue;
      const childSuffix = session?.showName ? ` · ${entry.name}` : suffix;
      parts.push(...(await storageParts(child, childLayout, excludedPaths, childSuffix)));
    }
    claimed.add(child);
  }
  parts.push({
    path,
    label: layout.remainder + suffix,
    excludedPaths: [...claimed],
    confirmation: layout.remainderConfirmation,
  });
  return parts;
}
