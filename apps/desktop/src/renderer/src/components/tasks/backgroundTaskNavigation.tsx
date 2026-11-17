import { ExternalLink } from 'lucide-react';
import type { BackgroundTask } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target.shared';
import { useDbRepairWindow } from '../../state/dbRepairWindow';
import { requestOpenSettings } from '../../lib/callSettingsBridge';
import type { TaskQuickAction } from './TaskQuickActions';

export function backgroundTaskNavigation(task: BackgroundTask): TaskQuickAction | null {
  if (task.destination === 'enhancement-packs')
    return {
      id: 'open-enhancement-packs',
      label: '打开增强包设置',
      icon: <ExternalLink size={14} />,
      run: () => requestOpenSettings('enhancementPacks'),
    };
  const uin = task.scope?.uin;
  if (IS_WEB || task.destination !== 'db-checkup' || !uin) return null;
  return {
    id: 'open-db-checkup',
    label: '打开数据库体检',
    icon: <ExternalLink size={14} />,
    run: () => useDbRepairWindow.getState().open({ uin, name: uin, avatarUrl: '' }),
  };
}
