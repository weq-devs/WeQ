import '../../styles/data-maintenance.css';
import { REMOTE_BLOCKED_MAINTENANCE_TOOLS } from '../../../../shared/remote_capabilities';
import { MAINTENANCE_TOOL_ICONS } from '../../lib/featureIcons.shared';

/** 清单本身在 shared/remote_capabilities（导航、设置搜索、维护工具共用一份）。 */
export const remoteUnsupportedTools: readonly MaintenanceTool[] = REMOTE_BLOCKED_MAINTENANCE_TOOLS;

export type MaintenanceTool =
  | 'cache'
  | 'database'
  | 'storage'
  | 'cleanup'
  | 'db-repair'
  | 'db-decrypt'
  | 'key-scan'
  | 'other-device-key'
  | 'login-accounts'
  | 'capture'
  | 'reverse';

export const MAINTENANCE_TOOLS = [
  {
    id: 'cache',
    label: '资源查看',
    actionLabel: '浏览资源',
    settingId: 'resource-viewer',
    icon: MAINTENANCE_TOOL_ICONS.cache,
    needsResources: true,
  },
  {
    id: 'database',
    label: '数据库浏览',
    actionLabel: '打开数据库浏览',
    settingId: 'database-manager',
    icon: MAINTENANCE_TOOL_ICONS.database,
    needsResources: false,
  },
  {
    id: 'storage',
    label: '占用分析',
    actionLabel: '分析占用',
    settingId: 'qq-storage-analysis',
    icon: MAINTENANCE_TOOL_ICONS.storage,
    needsResources: true,
  },
  {
    id: 'cleanup',
    label: '缓存清理',
    actionLabel: '打开清理工具',
    settingId: 'qq-storage-cleanup',
    icon: MAINTENANCE_TOOL_ICONS.cleanup,
    needsResources: true,
  },
  {
    id: 'db-repair',
    label: '检查与修复',
    actionLabel: '打开修复工具',
    settingId: 'database-repair',
    icon: MAINTENANCE_TOOL_ICONS['db-repair'],
    needsResources: false,
  },
  {
    id: 'db-decrypt',
    label: '导出明文数据库',
    actionLabel: '打开导出工具',
    settingId: 'database-export',
    icon: MAINTENANCE_TOOL_ICONS['db-decrypt'],
    needsResources: false,
  },
  {
    id: 'key-scan',
    label: '密钥扫描',
    actionLabel: '打开密钥扫描',
    settingId: 'key-scan',
    icon: MAINTENANCE_TOOL_ICONS['key-scan'],
    needsResources: false,
  },
  {
    id: 'other-device-key',
    label: '其他设备密钥',
    actionLabel: '查看设备密钥',
    settingId: 'other-device-key',
    icon: MAINTENANCE_TOOL_ICONS['other-device-key'],
    needsResources: false,
  },
  {
    id: 'login-accounts',
    label: 'QQ 登录账号管理',
    actionLabel: '管理登录账号',
    settingId: 'qq-accounts',
    icon: MAINTENANCE_TOOL_ICONS['login-accounts'],
    needsResources: false,
  },
] as const;
