import type { ReactElement } from 'react';
import { ToolSurface } from '../ToolSurface';
import { PageShell } from '../PageShell';
import type { DbRepairAccountOption } from '../DbRepairPanel';
import { DbRepairWindowRequest } from '../DbRepairWindow';
import { CaptureWindowRequest } from '../CaptureWindow';
import { CacheView } from '../../views/cache/CacheView';
import { DbExplorer } from '../../views/cache/DbExplorer';
import { ResourceAnalyticsDialog } from '../../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../../views/cache/ResourceCleanupDialog';
import { WonderfulToolsDialog } from '../WonderfulToolsDialog';
import { ExportTool } from '../lazyWorkspaces';
import { useRemoteClient } from '../../lib/remoteClient';
import {
  MAINTENANCE_TOOLS,
  remoteUnsupportedTools,
  type MaintenanceTool,
} from './DataMaintenanceSection';
import '../../styles/cache.css';
import '../../styles/data-maintenance.css';

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
  const remote = useRemoteClient();
  if (!tool) return null;
  if (remote && remoteUnsupportedTools.includes(tool)) return null;
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
  const label = MAINTENANCE_TOOLS.find((entry) => entry.id === tool)?.label ?? '数据与维护';
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
