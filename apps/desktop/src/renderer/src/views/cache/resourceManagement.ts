import type { CleanupTargetStat, ResourceStat, ResourceTreeKey } from '@weq/service';

/** 分析按顶层目录计总量；清理子目标只用于选择与估算，不再累加到该总量。 */
export const RESOURCE_CATEGORIES = [
  { key: 'pic', label: '图片', cleanup: ['pic'], browse: ['image'] },
  { key: 'video', label: '视频', cleanup: ['video'], browse: ['video'] },
  { key: 'ptt', label: '语音', cleanup: ['ptt'], browse: ['voice'] },
  {
    key: 'emoji',
    label: '表情',
    cleanup: ['marketface', 'emojiRecv', 'personalEmoji', 'emojiRelated'],
    browse: ['sysEmoji', 'marketEmoji', 'marketPack', 'customEmoji', 'relatedEmoji'],
  },
  { key: 'avatar', label: '头像', cleanup: ['avatar'], browse: ['avatar'] },
  { key: 'photoWall', label: '图片墙', cleanup: ['photoWall'], browse: ['album'] },
  { key: 'qzone', label: 'QQ 空间', cleanup: ['qzone'], browse: ['qzone'] },
  { key: 'file', label: '文件', cleanup: ['file'], browse: ['fileDir', 'downloadFile'] },
] as const satisfies readonly {
  key: ResourceTreeKey;
  label: string;
  cleanup: readonly string[];
  browse: readonly string[];
}[];

export interface ResourceSource {
  expectedAccountUin: string;
  expectedAccountConfigId: string;
}

export interface ResourceManagementSnapshot {
  source: ResourceSource;
  stats: ResourceStat[];
  targets: CleanupTargetStat[];
  scanningKey: ResourceTreeKey | 'cleanup' | null;
  complete: boolean;
  error: string | null;
  revision: number;
  cleanupRunning?: boolean;
  refresh: () => Promise<void>;
}
