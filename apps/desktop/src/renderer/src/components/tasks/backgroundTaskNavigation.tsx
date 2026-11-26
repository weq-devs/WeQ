import { ExternalLink } from 'lucide-react';
import type { BackgroundTask } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target.shared';
import { useDbRepairWindow } from '../../state/dbRepairWindow';
import { requestOpenSettings } from '../../lib/callSettingsBridge';
import {
  notificationSource,
  openNotificationSource,
} from '../../lib/notificationNavigation.shared';
import type { TaskQuickAction } from './TaskQuickActions';

export function backgroundTaskNavigation(task: BackgroundTask): TaskQuickAction | null {
  const binding = task.scope?.configId
    ? { expectedAccountUin: task.scope.uin, expectedAccountConfigId: task.scope.configId }
    : undefined;
  if (task.messageTarget && binding) {
    const target = task.messageTarget;
    return {
      id: 'open-message',
      label: '查看消息',
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(
          notificationSource(
            { kind: 'conversation', ...target, dismissTaskPanel: true },
            '查看消息',
            binding,
          ),
        ),
    };
  }
  if (task.forwardTargets?.length && binding) {
    const targets = task.forwardTargets.map((target) => ({ ...target, avatarUrl: '' }));
    const label = targets.length === 1 ? '打开转发会话' : '选择转发会话';
    return {
      id: 'open-forward-target',
      label,
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(
          notificationSource({ kind: 'forwarded-conversations', targets, binding }, label, binding),
        ),
    };
  }
  if (task.qzonePost || (task.kind === 'qzone-share' && task.needsConfirmation && task.scope)) {
    const target = task.qzonePost
      ? { kind: 'post' as const, ...task.qzonePost }
      : { kind: 'space' as const, uin: task.scope!.uin };
    const label = task.qzonePost ? '查看原帖' : '打开 QQ 空间';
    return {
      id: 'open-qzone-post',
      label,
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(notificationSource({ kind: 'qzone', target }, label, binding)),
    };
  }
  if (task.groupAlbum) {
    const { groupCode, albumId } = task.groupAlbum;
    return {
      id: 'open-group-album',
      label: '打开群相册',
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(
          notificationSource(
            {
              kind: 'group-resource',
              request: {
                kind: 'albums',
                groupCode,
                groupName: groupCode,
                initialAlbumId: albumId,
              },
            },
            '打开群相册',
          ),
        ),
    };
  }
  if (task.destination === 'group-intersection')
    return {
      id: 'open-group-intersection',
      label: '查看群交集',
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(
          notificationSource({ kind: 'app', target: { kind: 'contact-overview' } }, '查看群交集'),
        ),
    };
  if (task.kind === 'update' && !IS_WEB)
    return {
      id: 'open-app-update',
      label: '打开版本与更新',
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(
          notificationSource(
            {
              kind: 'app',
              target: { kind: 'setting', section: 'version', settingId: 'software-update' },
            },
            '打开版本与更新',
            null,
          ),
        ),
    };
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
    label: '查看数据库检查结果',
    icon: <ExternalLink size={14} />,
    run: () =>
      useDbRepairWindow.getState().open({
        uin,
        configId: task.scope?.configId,
        reportId: task.reportId,
        name: uin,
        avatarUrl: '',
      }),
  };
}
