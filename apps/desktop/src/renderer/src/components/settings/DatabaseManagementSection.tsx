import { ArrowUpRight, Database } from 'lucide-react';
import { useDatabaseBrowserWindow } from '../../state/databaseBrowserWindow';
import { DatabaseRepairSection } from './DatabaseRepairSection';
import { AccountBasicsSection } from './AccountBasicsSection';
import { Card, Row, SectionHeader } from './controls';
import type { MaintenanceTool } from './DataMaintenanceSection';
import '../../styles/settings-database.css';

export function DatabaseManagementSection({ onOpen }: { onOpen: (tool: MaintenanceTool) => void }) {
  return (
    <div className="weq-set weq-database-management">
      <SectionHeader title="QQ 数据库管理" page="database-management" />
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
      <AccountBasicsSection page="listening" heading={false} />
      <DatabaseRepairSection onOpen={onOpen} />
    </div>
  );
}
