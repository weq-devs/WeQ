import type { ReactElement } from 'react';
import { ArrowLeft, ChevronRight, Database, DatabaseZap, HardDrive, Trash2 } from 'lucide-react';
import { Modal } from '../Dialog';
import { DbRepairPanel, type DbRepairAccountOption } from '../DbRepairPanel';
import { DbExplorer } from '../../views/cache/DbExplorer';
import { ResourceAnalyticsDialog } from '../../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../../views/cache/ResourceCleanupDialog';
import { SectionHeader } from './controls';
import { trpc } from '../../trpc/client';
import '../../styles/cache.css';
import '../../styles/data-maintenance.css';

export type MaintenanceTool = 'database' | 'storage' | 'cleanup' | 'db-repair';

const TOOLS = [
  { id: 'database', label: '数据库管理', icon: Database, needsResources: false },
  { id: 'storage', label: '存储占用', icon: HardDrive, needsResources: true },
  { id: 'cleanup', label: '清理缓存', icon: Trash2, needsResources: true },
  { id: 'db-repair', label: '数据库修复', icon: DatabaseZap, needsResources: false },
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
    <div className="weq-data-maintenance">
      <SectionHeader title="数据与维护" />
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
  const utils = trpc.useUtils();
  if (!tool) return null;
  if (tool === 'storage') return <ResourceAnalyticsDialog open onClose={onClose} />;
  if (tool === 'cleanup') return <ResourceCleanupDialog open onClose={onClose} />;
  return (
    <Modal
      onClose={onClose}
      width={1100}
      className="weq-maintenance-dialog"
      labelledBy="weq-maintenance-title"
    >
      <header className="weq-maintenance-head">
        <button type="button" onClick={onClose} aria-label="返回数据与维护" title="返回数据与维护">
          <ArrowLeft size={18} />
        </button>
        <h2 id="weq-maintenance-title">{TOOLS.find((entry) => entry.id === tool)?.label}</h2>
        <span>{account.name || account.uin}</span>
      </header>
      <div className={`weq-maintenance-body${tool === 'database' ? ' is-database' : ''}`}>
        {tool === 'database' ? (
          <DbExplorer />
        ) : (
          <DbRepairPanel
            currentUin={account.uin}
            accounts={[account]}
            onRefreshAccounts={() => {
              void utils.account.getAccountConfig.invalidate();
            }}
          />
        )}
      </div>
    </Modal>
  );
}
