import type { ReactElement } from 'react';
import {
  ChevronRight,
  Database,
  DatabaseZap,
  FolderOpen,
  HardDrive,
  KeyRound,
  Trash2,
  X,
} from 'lucide-react';
import { WorkspacePage } from '../WorkspacePages';
import type { DbRepairAccountOption } from '../DbRepairPanel';
import { DbRepairWindowRequest } from '../DbRepairWindow';
import { CacheView } from '../../views/cache/CacheView';
import { DbExplorer } from '../../views/cache/DbExplorer';
import { ResourceAnalyticsDialog } from '../../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../../views/cache/ResourceCleanupDialog';
import { SectionHeader } from './controls';
import { trpc } from '../../trpc/client';
import '../../styles/cache.css';
import '../../styles/data-maintenance.css';
import { WonderfulToolsDialog } from '../WonderfulToolsDialog';
import { ExportTool } from '../../views/ExportView';

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

const TOOLS = [
  { id: 'cache', label: '本地缓存', icon: FolderOpen, needsResources: true },
  { id: 'database', label: '数据库管理', icon: Database, needsResources: false },
  { id: 'storage', label: '存储占用', icon: HardDrive, needsResources: true },
  { id: 'cleanup', label: '清理缓存', icon: Trash2, needsResources: true },
  { id: 'db-repair', label: '数据库修复', icon: DatabaseZap, needsResources: false },
  { id: 'db-decrypt', label: '导出明文数据库', icon: Database, needsResources: false },
  { id: 'key-scan', label: '密钥扫描', icon: KeyRound, needsResources: false },
  { id: 'other-device-key', label: '其它设备密钥', icon: KeyRound, needsResources: false },
] as const;

export function DataMaintenanceSection({
  onOpen,
}: {
  onOpen: (tool: MaintenanceTool) => void;
}): ReactElement {
  const account = trpc.account.getAccountConfig.useQuery(undefined, {
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  return (
    <div className="weq-set weq-data-maintenance">
      <SectionHeader title="维护工具" desc="当前账号；各项在独立工具中打开。" />
      {account.isError ? (
        <div role="alert" className="weq-maintenance-status">
          {account.error.message}
          <button type="button" className="weq-set-btn" onClick={() => void account.refetch()}>
            重试
          </button>
        </div>
      ) : null}
      <div className="weq-maintenance-list">
        {TOOLS.map(({ id, label, icon: Icon, needsResources }) => {
          const unavailable = needsResources && account.data?.static;
          return (
            <button
              type="button"
              className="weq-maintenance-entry"
              key={id}
              onClick={() => onOpen(id)}
              disabled={!account.data || account.isFetching || account.isError || unavailable}
              title={unavailable ? '静态账号暂不支持本地资源维护' : label}
            >
              <Icon size={18} aria-hidden />
              <span>{label}</span>
              {unavailable ? <small>静态账号不可用</small> : null}
              <ChevronRight size={16} aria-hidden />
            </button>
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

/** 与设置互斥显示，维护工具不会再叠在设置遮罩上。 */
export function DataMaintenanceDialog({
  tool,
  account,
  onClose,
}: {
  tool: MaintenanceTool | null;
  account: DbRepairAccountOption;
  onClose: () => void;
}): ReactElement | null {
  if (!tool) return null;
  if (tool === 'db-repair') return <DbRepairWindowRequest key={account.uin} account={account} />;
  if (
    tool === 'key-scan' ||
    tool === 'other-device-key' ||
    tool === 'login-accounts' ||
    tool === 'capture' ||
    tool === 'reverse'
  )
    return <WonderfulToolsDialog open initialTool={tool} tools={[tool]} onClose={onClose} />;
  if (tool === 'storage') return <ResourceAnalyticsDialog open onClose={onClose} />;
  if (tool === 'cleanup') return <ResourceCleanupDialog open onClose={onClose} />;
  const label = TOOLS.find((entry) => entry.id === tool)?.label ?? '数据与维护';
  const flush = tool === 'database' || tool === 'cache';
  return (
    <WorkspacePage title={label} onClose={onClose}>
      <div className="weq-maintenance-dialog" role="region" aria-labelledby="weq-maintenance-title">
        <button
          type="button"
          className="weq-maintenance-close"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
        >
          <X size={18} strokeWidth={2} />
        </button>
        <header className="weq-maintenance-head">
          <h2 id="weq-maintenance-title">{label}</h2>
          <span>{account.name || account.uin}</span>
        </header>
        <div className={`weq-maintenance-body${flush ? ' is-flush' : ''}`}>
          {tool === 'cache' ? (
            <CacheView />
          ) : tool === 'database' ? (
            <DbExplorer />
          ) : tool === 'db-decrypt' ? (
            <ExportTool initialMode="database" lockMode />
          ) : null}
        </div>
      </div>
    </WorkspacePage>
  );
}
