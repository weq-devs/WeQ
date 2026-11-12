import { useState } from 'react';
import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { IS_WEB } from '../../lib/target';
import { Row, Toggle } from './controls';

export function MessageNotificationRows() {
  useClientPreferences((state) => state.tick);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(key: 'messageNotifications' | 'applicationBadge', value: boolean) {
    setBusy(true);
    setError('');
    try {
      const permission =
        key === 'messageNotifications' && value && IS_WEB && typeof Notification !== 'undefined'
          ? Notification.requestPermission().catch(() => 'denied')
          : null;
      if (!(await changePreference(key, value))) {
        setError('设置尚未保存，请重试');
        return;
      }
      if (key === 'messageNotifications' && value && IS_WEB) {
        if (typeof Notification === 'undefined')
          setError('当前浏览器不能显示系统通知，共享设置已保留');
        else if ((await permission) !== 'granted') setError('当前浏览器未允许通知，共享设置已保留');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Row
        settingId="message-system-notifications"
        label="新消息系统通知"
        control={
          <Toggle
            label="新消息系统通知"
            checked={preferenceValue('messageNotifications')}
            disabled={busy}
            onChange={(value) => void change('messageNotifications', value)}
          />
        }
      />
      <Row
        settingId="application-unread-badge"
        label="应用图标未读角标"
        control={
          <Toggle
            label="应用图标未读角标"
            checked={preferenceValue('applicationBadge')}
            disabled={busy}
            onChange={(value) => void change('applicationBadge', value)}
          />
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
