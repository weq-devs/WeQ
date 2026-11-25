import { Database } from 'lucide-react';
import { NumericText } from './NumericText';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useAccountSwitch } from '../state/accountSwitch';
import { useTabActive } from './RetainedTabs.shared';
import { QueryError } from './settings/controls';
import { EmptyState } from './EmptyState';
import { DatabaseBrowserSkeleton } from './PageSkeletons';
import { DbExplorer } from '../views/cache/DbExplorer';
import { ExportTool } from './lazyWorkspaces';
import { ToolSurface } from './ToolSurface';
import { PageShell } from './PageShell';
import {
  createDatabaseExportTarget,
  databaseExportTargetMatches,
  type DatabaseExportTarget,
} from '../../../shared/database_export_target';
import '../styles/cache.css';
import '../styles/data-maintenance.css';
import '../styles/settings-database.css';

export default function DatabaseBrowser() {
  const active = useTabActive();
  const switching = useAccountSwitch((state) => state.active);
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active && !switching && Boolean(uin),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const source =
    !switching && !config.isFetching && uin && config.data?.uin === uin && config.data.configId
      ? { expectedAccountUin: uin, expectedAccountConfigId: config.data.configId }
      : null;
  const identity = source
    ? JSON.stringify([source.expectedAccountUin, source.expectedAccountConfigId])
    : '';
  const latest = useRef(identity);
  latest.current = identity;
  const [target, setTarget] = useState<DatabaseExportTarget | null>(null);
  useEffect(() => {
    setTarget(null);
  }, [identity, active]);
  return (
    <div className="weq-database-browser-content">
      {config.error ? (
        <QueryError
          message={config.error.message}
          retryLabel="重新读取来源"
          onRetry={() => void config.refetch()}
        />
      ) : null}
      {source ? (
        <div className="weq-database-browser-source" role="status">
          <NumericText>{`当前账号：${source.expectedAccountUin}`}</NumericText>
        </div>
      ) : null}
      {source && !config.error ? (
        <DbExplorer
          key={identity}
          exportDisabled={config.isFetching}
          onExport={(database) => {
            if (!active || !source || latest.current !== identity) return;
            setTarget(createDatabaseExportTarget(source, [database.path]));
          }}
        />
      ) : config.error ? null : uin ? (
        <DatabaseBrowserSkeleton />
      ) : (
        <div className="weq-database-browser-empty">
          <EmptyState
            icon={<Database />}
            title="请先打开账号"
            body="打开一个 QQ 账号后，才能浏览本地数据库。"
          />
        </div>
      )}
      {active && target && databaseExportTargetMatches(target, source) ? (
        <ToolSurface title="导出明文数据库" presentation="modal" onClose={() => setTarget(null)}>
          {(requestClose) => (
            <div className="weq-maintenance-dialog">
              <PageShell title="导出明文数据库" onClose={requestClose}>
                <div className="weq-maintenance-body">
                  <ExportTool databaseTarget={target} lockMode onClose={requestClose} />
                </div>
              </PageShell>
            </div>
          )}
        </ToolSurface>
      ) : null}
    </div>
  );
}
