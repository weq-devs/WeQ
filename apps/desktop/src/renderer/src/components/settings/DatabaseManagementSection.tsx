import { useEffect, useState } from 'react';
import { ArrowUpRight, Database, HardDrive } from 'lucide-react';
import { useTabActive } from '../RetainedTabs';
import { ToolSurface } from '../ToolSurface';
import { PageShell } from '../PageShell';
import { useDatabaseBrowserWindow } from '../../state/databaseBrowserWindow';
import { DatabaseToleranceSection } from './DatabaseToleranceSection';
import { Card, Row, SectionHeader } from './controls';
import { DataMaintenanceSection, type MaintenanceTool } from './DataMaintenanceSection';
import '../../styles/settings-database.css';

export function DatabaseManagementSection({ onOpen }: { onOpen: (tool: MaintenanceTool) => void }) {
  const active = useTabActive();
  const [recordsOpen, setRecordsOpen] = useState(false);
  useEffect(() => {
    if (!active) setRecordsOpen(false);
  }, [active]);
  return (
    <div className="weq-set weq-database-management">
      <SectionHeader title="QQ 数据库管理" icon={<HardDrive size={16} />} />
      <Card title="数据库浏览" icon={<Database size={15} />} settingId="database-manager">
        <Row
          label="库、表与记录"
          control={
            <button
              type="button"
              className="weq-set-btn"
              data-setting-id="database-export"
              onClick={() => useDatabaseBrowserWindow.getState().open()}
            >
              打开数据库浏览
              <ArrowUpRight size={14} />
            </button>
          }
        />
      </Card>
      <DatabaseToleranceSection
        page="management"
        onOpenRecords={() => setRecordsOpen(true)}
        repairAction={<DataMaintenanceSection title={null} onOpen={onOpen} tools={['db-repair']} />}
      />
      {recordsOpen && (
        <ToolSurface title="容错记录" presentation="modal" onClose={() => setRecordsOpen(false)}>
          {(requestClose) => (
            <PageShell title="容错记录" onClose={requestClose}>
              <DatabaseToleranceSection page="status" />
            </PageShell>
          )}
        </ToolSurface>
      )}
    </div>
  );
}
