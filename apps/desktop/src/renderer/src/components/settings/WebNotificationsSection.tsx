import { useState } from 'react';
import { useWebNotices } from '../../state/webNotices';
import { Card, Row, Toggle } from './controls';

export function WebNotificationsSection() {
  const enabled = useWebNotices((state) => state.enabled);
  const set = useWebNotices((state) => state.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = typeof Notification !== 'undefined';
  async function change(next: boolean) {
    if (!next) {
      set(false);
      return;
    }
    if (!available || busy) return;
    setBusy(true);
    setError('');
    try {
      const permission = await Notification.requestPermission();
      set(permission === 'granted');
      if (permission !== 'granted') setError('浏览器未允许通知。');
    } catch {
      setError('无法开启此设备通知。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="此设备通知">
      <Row
        label="撤回、群关键词与邮件提醒"
        control={
          <Toggle
            label="此设备通知"
            checked={enabled && available}
            disabled={!available || busy}
            onChange={(next) => void change(next)}
          />
        }
      />
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
