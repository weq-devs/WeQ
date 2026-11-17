import { DatabaseZap } from 'lucide-react';
import { Card, Row } from './controls';
import { NotificationSettingsLink } from './NotificationSettingsLink';
import { DataMaintenanceSection, type MaintenanceTool } from './DataMaintenanceSection';

export function DatabaseRepairSection({ onOpen }: { onOpen: (tool: MaintenanceTool) => void }) {
  return (
    <Card title="数据库检查与修复" icon={<DatabaseZap size={15} />} settingId="database-repair">
      <Row
        settingId="damage-reminder"
        label="数据库异常提醒"
        control={
          <NotificationSettingsLink settingId="damage-reminder">通知设置</NotificationSettingsLink>
        }
      />
      <DataMaintenanceSection title={null} onOpen={onOpen} tools={['db-repair']} />
    </Card>
  );
}
