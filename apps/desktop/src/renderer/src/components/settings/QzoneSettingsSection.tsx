import { Globe } from 'lucide-react';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { trpc } from '../../trpc/client';
import { QzonePaginationSettings } from './QzonePaginationSettings';
import { QzonePublicRefreshSettings } from './QzonePublicRefreshSettings';
import { QzoneFriendPermissions } from '../qq-actions/QzoneFriendPermissions';
import { SegmentedControl } from '../SegmentedControl';

export function QzoneSettingsSection() {
  const settings = trpc.bootstrap.getSettings.useQuery();
  const save = trpc.bootstrap.setQzoneForwardQuotePrevious.useMutation({
    onSuccess: () => void settings.refetch(),
  });
  const savePersonAction = trpc.bootstrap.setQzonePersonClickAction.useMutation({
    onSuccess: () => void settings.refetch(),
  });
  return (
    <div className="weq-set">
      <SectionHeader icon={<Globe size={16} strokeWidth={1.8} />} title="QQ 空间" />
      <QzonePaginationSettings />
      <QzonePublicRefreshSettings />
      <Card title="人物入口" settingId="qzone-person-click">
        <Row
          label="点击他人昵称或头像时"
          control={
            <SegmentedControl
              label="点击他人昵称或头像时"
              value={settings.data?.qzonePersonClickAction ?? null}
              options={
                [
                  { value: 'profile', label: '显示名片' },
                  { value: 'space', label: '进入对方空间' },
                ] as const
              }
              disabled={!settings.data || savePersonAction.isLoading}
              onChange={(action) => savePersonAction.mutate({ action })}
            />
          }
        />
        {savePersonAction.error ? (
          <p className="weq-qzn-error">{savePersonAction.error.message}</p>
        ) : null}
      </Card>
      <Card title="转发" settingId="qzone-forward">
        <Row
          label="转发时引用上一人文案"
          control={
            <Toggle
              label="转发时引用上一人文案"
              checked={settings.data?.qzoneForwardQuotePrevious === true}
              disabled={!settings.data || save.isLoading}
              onChange={(enabled) => save.mutate({ enabled })}
            />
          }
        />
        {save.error ? <p className="weq-qzn-error">{save.error.message}</p> : null}
      </Card>
      <QzoneFriendPermissions />
    </div>
  );
}
