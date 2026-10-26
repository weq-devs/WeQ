import { useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { useTabActive } from '../RetainedTabs';
import { SectionHeader, QueryError } from './controls';
import { DbExplorer } from '../../views/cache/DbExplorer';
import { ExportTool } from '../../views/ExportView';
import { ToolSurface } from '../ToolSurface';
import { PageShell } from '../PageShell';
import {
  createDatabaseExportTarget,
  databaseExportTargetMatches,
  type DatabaseExportTarget,
} from '../../../../shared/database_export_target';
import '../../styles/cache.css';
import '../../styles/data-maintenance.css';
import '../../styles/settings-database.css';

export function DatabaseManagementSection() {
  const active = useTabActive();
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const source =
    uin && config.data?.uin === uin && config.data.configId
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
    <div className="weq-settings-database" data-setting-id="database-manager">
      <SectionHeader title="数据库管理" icon={<HardDrive size={16} strokeWidth={1.8} />} />
      {config.error ? (
        <QueryError
          message={config.error.message}
          retryLabel="重新读取来源"
          onRetry={() => void config.refetch()}
        />
      ) : null}
      <DbExplorer
        key={identity}
        exportDisabled={!source || config.isFetching || Boolean(config.error)}
        onExport={(database) => {
          if (!active || !source || latest.current !== identity) return;
          setTarget(createDatabaseExportTarget(source, [database.path]));
        }}
      />
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
