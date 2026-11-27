import { ArrowUpRight, Database } from 'lucide-react';
import { useContext } from 'react';
import { useDatabaseBrowserWindow } from '../../state/databaseBrowserWindow';
import { DatabaseRepairSection } from './DatabaseRepairSection';
import { AccountBasicsSection } from './AccountBasicsSection';
import { Card, Row, SectionHeader } from './controls';
import { BeforeLoginSettingsContext, OPEN_ACCOUNT_SETTINGS_HINT } from './controls.shared';
import { SETTINGS_PAGE_LABELS } from './navigation';
import type { MaintenanceTool } from './DataMaintenanceSection';
import '../../styles/settings-database.css';

export function DatabaseManagementSection({ onOpen }: { onOpen: (tool: MaintenanceTool) => void }) {
  const beforeLogin = useContext(BeforeLoginSettingsContext);
  return (
    <div className="weq-set weq-database-management">
      <SectionHeader
        title={SETTINGS_PAGE_LABELS['database-management']}
        page="database-management"
      />
      <Card title="数据库浏览" icon={<Database size={15} />} settingId="database-manager">
        <Row
          label="库、表与记录"
          desc={beforeLogin ? OPEN_ACCOUNT_SETTINGS_HINT : undefined}
          control={
            <button
              type="button"
              className="weq-set-btn"
              data-setting-id="database-export"
              disabled={beforeLogin}
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
