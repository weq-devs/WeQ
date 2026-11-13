import { ExternalLink } from 'lucide-react';
import type { BackgroundTask } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target';
import { useDbRepairWindow } from '../../state/dbRepairWindow';
import type { TaskQuickAction } from './TaskQuickActions';

export function backgroundTaskNavigation(task: BackgroundTask): TaskQuickAction | null {
  const uin = task.scope?.uin;
  if (IS_WEB || task.destination !== 'db-checkup' || !uin) return null;
  return {
    id: 'open-db-checkup',
    label: '打开数据库体检',
    icon: <ExternalLink size={14} />,
    run: () => useDbRepairWindow.getState().open({ uin, name: uin, avatarUrl: '' }),
  };
}
