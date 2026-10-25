import type { ReactElement } from 'react';
import {
  ChevronRight,
  Database,
  DatabaseZap,
  FolderOpen,
  HardDrive,
  KeyRound,
  Trash2,
} from 'lucide-react';
import { ToolSurface } from '../ToolSurface';
import { PageShell } from '../PageShell';
import type { DbRepairAccountOption } from '../DbRepairPanel';
import { DbRepairWindowRequest } from '../DbRepairWindow';
import { CaptureWindowRequest } from '../CaptureWindow';
import { CacheView } from '../../views/cache/CacheView';
import { DbExplorer } from '../../views/cache/DbExplorer';
import { ResourceAnalyticsDialog } from '../../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../../views/cache/ResourceCleanupDialog';
import { SectionHeader } from './controls';
import { useTabActive } from '../RetainedTabs';
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
  {
    id: 'cache',
    label: '资源查看',
    settingId: 'resource-viewer',
    icon: FolderOpen,
    needsResources: true,
  },
  {
    id: 'database',
    label: '数据库管理',
    settingId: 'database-manager',
    icon: Database,
    needsResources: false,
  },
  {
    id: 'storage',
    label: '占用分析',
    settingId: 'qq-storage-analysis',
    icon: HardDrive,
    needsResources: true,
  },
  {
    id: 'cleanup',
    label: '缓存清理',
    settingId: 'qq-storage-cleanup',
    icon: Trash2,
    needsResources: true,
  },
  {
    id: 'db-repair',
    label: '数据库修复',
    settingId: 'database-repair',
    icon: DatabaseZap,
    needsResources: false,
  },
  {
    id: 'db-decrypt',
    label: '导出明文数据库',
    settingId: 'database-export',
    icon: Database,
    needsResources: false,
  },
  {
    id: 'key-scan',
    label: '密钥扫描',
    settingId: 'key-scan',
    icon: KeyRound,
    needsResources: false,
  },
  {
    id: 'other-device-key',
    label: '其他设备密钥',
    settingId: 'other-device-key',
    icon: KeyRound,
    needsResources: false,
  },
  {
    id: 'login-accounts',
    label: 'QQ 登录账号管理',
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
  const account = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const visibleTools = tools
    ? tools.flatMap((id) => TOOLS.filter((tool) => tool.id === id))
    : TOOLS.filter((tool) => tool.id !== 'login-accounts');
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
            重试
          </button>
        </div>
      ) : null}
      <div className="weq-maintenance-list">
        {visibleTools.map(({ id, label, settingId, icon: Icon, needsResources }) => {
          const unavailable = needsResources && account.data?.static;
          return (
            <button
              type="button"
              className="weq-maintenance-entry"
              key={id}
              data-setting-id={settingId}
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

/** 设置来源在原页面之上打开，不替换设置工作区。 */
export function DataMaintenanceDialog({
  tool,
  source,
  account,
  onClose,
}: {
  tool: MaintenanceTool | null;
  source: string;
  account: DbRepairAccountOption;
  onClose: () => void;
}): ReactElement | null {
  if (!tool) return null;
  if (tool === 'db-repair') return <DbRepairWindowRequest key={account.uin} account={account} />;
  if (tool === 'capture')
    return (
      <CaptureWindowRequest key={source} source={source} uin={account.uin} onRequested={onClose} />
    );
  if (
    tool === 'key-scan' ||
    tool === 'other-device-key' ||
    tool === 'login-accounts' ||
    tool === 'reverse'
  )
    return (
      <WonderfulToolsDialog
        open
        presentation="modal"
        initialTool={tool}
        tools={[tool]}
        onClose={onClose}
      />
    );
  if (tool === 'storage')
    return <ResourceAnalyticsDialog open presentation="modal" onClose={onClose} />;
  if (tool === 'cleanup')
    return <ResourceCleanupDialog open presentation="modal" onClose={onClose} />;
  const label = TOOLS.find((entry) => entry.id === tool)?.label ?? '数据与维护';
  const flush = tool === 'database' || tool === 'cache';
  return (
    <ToolSurface title={label} onClose={onClose} presentation="modal">
      {(requestClose) => (
        <div
          className="weq-maintenance-dialog"
          role="region"
          aria-labelledby="weq-maintenance-title"
        >
          <PageShell
            title={label}
            titleId="weq-maintenance-title"
            meta={account.name || account.uin}
            onClose={requestClose}
          >
            <div className={`weq-maintenance-body${flush ? ' is-flush' : ''}`}>
              {tool === 'cache' ? (
                <CacheView />
              ) : tool === 'database' ? (
                <DbExplorer />
              ) : tool === 'db-decrypt' ? (
                <ExportTool initialMode="database" lockMode />
              ) : null}
            </div>
          </PageShell>
        </div>
      )}
    </ToolSurface>
  );
}
