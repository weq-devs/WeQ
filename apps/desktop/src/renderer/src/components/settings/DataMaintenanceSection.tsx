import type { ReactElement } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Database,
  DatabaseZap,
  FolderOpen,
  HardDrive,
  KeyRound,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Row, SectionHeader } from './controls';
import { useTabActive } from '../RetainedTabs';
import { trpc } from '../../trpc/client';
import '../../styles/data-maintenance.css';
import { useRemoteClient } from '../../lib/remoteClient';
import { REMOTE_BLOCKED_MAINTENANCE_TOOLS } from '../../../../shared/remote_capabilities';

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
    icon: FolderOpen,
    needsResources: true,
  },
  {
    id: 'database',
    label: '数据库管理',
    actionLabel: '打开数据库浏览',
    settingId: 'database-manager',
    icon: Database,
    needsResources: false,
  },
  {
    id: 'storage',
    label: '占用分析',
    actionLabel: '分析占用',
    settingId: 'qq-storage-analysis',
    icon: HardDrive,
    needsResources: true,
  },
  {
    id: 'cleanup',
    label: '缓存清理',
    actionLabel: '打开清理工具',
    settingId: 'qq-storage-cleanup',
    icon: Trash2,
    needsResources: true,
  },
  {
    id: 'db-repair',
    label: '数据库修复',
    actionLabel: '打开修复工具',
    settingId: 'database-repair',
    icon: DatabaseZap,
    needsResources: false,
  },
  {
    id: 'db-decrypt',
    label: '导出明文数据库',
    actionLabel: '打开导出工具',
    settingId: 'database-export',
    icon: Database,
    needsResources: false,
  },
  {
    id: 'key-scan',
    label: '密钥扫描',
    actionLabel: '打开密钥扫描',
    settingId: 'key-scan',
    icon: KeyRound,
    needsResources: false,
  },
  {
    id: 'other-device-key',
    label: '其他设备密钥',
    actionLabel: '查看设备密钥',
    settingId: 'other-device-key',
    icon: KeyRound,
    needsResources: false,
  },
  {
    id: 'login-accounts',
    label: 'QQ 登录账号管理',
    actionLabel: '管理登录账号',
    settingId: 'qq-accounts',
    icon: KeyRound,
    needsResources: false,
  },
] as const;

export function DataMaintenanceSection({
  onOpen,
  tools,
  title = '维护工具',
}: {
  onOpen: (tool: MaintenanceTool) => void;
  tools?: readonly MaintenanceTool[];
  title?: string | null;
}): ReactElement {
  const active = useTabActive();
  const remote = useRemoteClient();
  const account = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const visibleTools = tools
    ? tools.flatMap((id) => MAINTENANCE_TOOLS.filter((tool) => tool.id === id))
    : MAINTENANCE_TOOLS.filter((tool) => tool.id !== 'login-accounts');
  return (
    <div className="weq-set weq-data-maintenance">
      {title ? (
        <SectionHeader
          title={title}
          desc={tools?.includes('login-accounts') ? undefined : '当前账号'}
        />
      ) : null}
      {account.isError ? (
        <div role="alert" className="weq-maintenance-status">
          {account.error.message}
          <button type="button" className="weq-set-btn" onClick={() => void account.refetch()}>
            <RefreshCw size={14} aria-hidden="true" />
            重试
          </button>
        </div>
      ) : null}
      <div className="weq-maintenance-rows">
        {visibleTools
          .filter(({ id }) => !remote || !remoteUnsupportedTools.includes(id))
          .map(({ id, label, actionLabel, settingId, icon: Icon, needsResources }) => {
            const unavailable = needsResources && account.data?.static;
            const OpenIcon = id === 'db-repair' || id === 'database' ? ArrowUpRight : ArrowRight;
            return (
              <Row
                key={id}
                label={
                  <span className="weq-maintenance-label">
                    <Icon size={15} aria-hidden />
                    {label}
                  </span>
                }
                desc={unavailable ? '静态账号不可用' : undefined}
                control={
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    data-setting-id={settingId}
                    onClick={() => onOpen(id)}
                    disabled={!account.data || account.isFetching || account.isError || unavailable}
                    title={unavailable ? '静态账号暂不支持本地资源维护' : undefined}
                  >
                    {actionLabel}
                    <OpenIcon size={14} aria-hidden />
                  </button>
                }
              />
            );
          })}
      </div>
      {!account.data && !account.isError ? (
        <div role="status" className="weq-maintenance-status">
          正在读取当前账号…
        </div>
      ) : null}
    </div>
  );
}
