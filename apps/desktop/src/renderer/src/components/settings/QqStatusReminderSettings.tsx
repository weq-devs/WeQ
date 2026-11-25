import { useRef, useState } from 'react';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog.shared';
import { NotificationMethodSelect } from './NotificationMethodSelect';
import { Card, Row, Toggle } from './controls';

export function QqStatusReminderSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, useQQAutoRefresh(true));
  const save = trpc.bootstrap.setQqStatusIndicatorEnabled.useMutation();
  const showError = useDialog((state) => state.showError);
  const saving = useRef(false);
  const [pending, setPending] = useState<boolean | null>(null);

  async function toggle(enabled: boolean) {
    if (saving.current) return;
    saving.current = true;
    setPending(enabled);
    try {
      await save.mutateAsync({ enabled });
      await settings.refetch();
    } catch (error) {
      showError('保存失败', error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setPending(null);
    }
  }

  return (
    <Card title="状态提醒" settingId="qq-status-reminders" resetId="qq-status-reminders">
      <Row
        settingId="qq-status-indicator"
        desc="QQ 在线能力或代理连接需要关注时，在窗口右上角显示一个提示。"
        control={
          <Toggle
            checked={pending ?? settings.data?.qqStatusIndicatorEnabled !== false}
            disabled={!settings.data || Boolean(settings.error) || pending !== null}
            onChange={(enabled) => void toggle(enabled)}
            label="显示 QQ 功能状态提示"
          />
        }
      />
      <Row
        settingId="qq-online-notification"
        label="在线能力受限时通知"
        desc="QQ 在线能力就绪后再次受限时，通过选定的方式提醒。"
        control={<NotificationMethodSelect event="runtime" />}
      />
    </Card>
  );
}
