import { useDialog } from '../Dialog.shared';
import type { ExportResourceSource } from '@weq/service';
import type { NotificationTarget } from '../../lib/notificationNavigation';
import { ExternalLink } from 'lucide-react';
import type { BackgroundTask } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target.shared';
import { useDbRepairWindow } from '../../state/dbRepairWindow';
import { requestOpenSettings } from '../../lib/callSettingsBridge';
import {
  notificationSource,
  openNotificationSource,
} from '../../lib/notificationNavigation.shared';
import { TaskQuickActions, type TaskQuickAction } from './TaskQuickActions';

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
  if (task.groupMemberOrder && binding) {
    const { groupCode, ...memberSort } = task.groupMemberOrder;
    return taskSourceAction(
      { kind: 'group', id: groupCode, section: 'members', memberSort },
      '查看群成员',
      binding,
    );
  }
  if (task.destination === 'resource-cleanup' && binding)
    return taskSourceAction(
      {
        kind: 'app',
        target: { kind: 'setting', section: 'qq-storage', settingId: 'qq-storage-cleanup' },
      },
      '打开资源清理',
      binding,
    );
  if (task.destination === 'intent-model-resources')
    return taskSourceAction(
      {
        kind: 'app',
        target: { kind: 'setting', section: 'intent-sense', settingId: 'intent-model-resources' },
      },
      '打开意图模型资源',
      null,
    );
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
            binding,
          ),
        ),
    };
  }
  if (task.kind === 'favorite-import' && task.status === 'completed' && binding) {
    const label = '打开收藏表情';
    return {
      id: 'open-favorite-emoji',
      label,
      icon: <ExternalLink size={14} />,
      run: () =>
        openNotificationSource(
          notificationSource(
            {
              kind: 'app',
              target: { kind: 'setting', section: 'qq-storage', settingId: 'favorite-emoji' },
            },
            label,
            binding,
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

type TaskBinding = NonNullable<ReturnType<typeof notificationSource>['binding']>;

export function taskSourceAction(
  target: NotificationTarget,
  label: string,
  binding: TaskBinding | null,
): TaskQuickAction {
  return {
    id: 'open-source',
    label,
    icon: <ExternalLink size={14} />,
    run: () =>
      openNotificationSource(
        notificationSource({ ...target, dismissTaskPanel: true }, label, binding),
      ),
  };
}

export function exportSourceAction(
  source: ExportResourceSource,
  binding: TaskBinding,
): TaskQuickAction {
  switch (source.kind) {
    case 'album-selection':
      return {
        id: 'open-source',
        label: '选择来源相册',
        icon: <ExternalLink size={14} />,
        run: () => {
          const dialog = useDialog.getState();
          dialog.showInfo(
            '选择来源相册',
            <ul className="weq-background-task-results">
              {source.albums.map((album) => {
                const action = exportSourceAction(album, binding);
                const id =
                  album.kind === 'group-album'
                    ? [album.groupCode, album.albumId]
                    : [album.uin, album.topicId];
                return (
                  <li key={JSON.stringify([album.kind, ...id])}>
                    <TaskQuickActions
                      variant="detail"
                      actions={[
                        {
                          ...action,
                          label: [action.label, ...id].filter(Boolean).join(' · '),
                          run: () => {
                            useDialog.getState().close();
                            return action.run();
                          },
                        },
                      ]}
                    />
                  </li>
                );
              })}
            </ul>,
          );
        },
      };
    case 'conversation':
      return taskSourceAction(source, '查看原消息', binding);
    case 'mail':
      return taskSourceAction(source, '查看原邮件', binding);
    case 'group-files':
      return taskSourceAction(
        {
          kind: 'group-resource',
          request: {
            kind: 'files',
            groupCode: source.groupCode,
            groupName: source.groupCode,
            initialFileId: source.fileId,
            initialFolderId: source.folderId,
          },
        },
        '打开群文件',
        binding,
      );
    case 'group-album':
      return taskSourceAction(
        {
          kind: 'group-resource',
          request: {
            kind: 'albums',
            groupCode: source.groupCode,
            groupName: source.groupCode,
            initialAlbumId: source.albumId,
          },
        },
        '打开群相册',
        binding,
      );
    case 'qzone-album':
      return taskSourceAction(
        {
          kind: 'qzone',
          target: source.topicId
            ? { kind: 'album', uin: source.uin, topicId: source.topicId }
            : { kind: 'media-list', uin: source.uin, pane: 'albums' },
        },
        '打开空间相册',
        binding,
      );
    case 'qzone-videos':
      return taskSourceAction(
        {
          kind: 'qzone',
          target: source.tid
            ? { kind: 'post', uin: source.uin, tid: source.tid }
            : { kind: 'media-list', uin: source.uin, pane: 'videos' },
        },
        source.tid ? '查看原说说' : '打开空间视频',
        binding,
      );
  }
}
