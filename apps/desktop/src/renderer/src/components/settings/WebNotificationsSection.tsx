import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useWebNotices } from '../../state/webNotices';
import { Card, Row, Toggle } from './controls';

export function WebNotificationsSection() {
  const enabled = useWebNotices((state) => state.enabled);
  const set = useWebNotices((state) => state.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = typeof Notification !== 'undefined';
  async function change(next: boolean) {
    set(next);
    if (!next) return;
    await authorize();
  }
  async function authorize() {
    if (!available || busy) return;
    setBusy(true);
    setError('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') setError('浏览器未允许通知。');
    } catch {
      setError('无法取得当前浏览器通知授权。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="网页通知" icon={<Bell size={15} strokeWidth={1.8} />}>
      <Row
        label="撤回、群关键词与邮件提醒"
        control={
          <Toggle
            label="网页通知"
            checked={enabled}
            disabled={busy}
            onChange={(next) => void change(next)}
          />
        }
      />
      {enabled && available && Notification.permission !== 'granted' && (
        <button
          type="button"
          className="weq-set-btn"
          disabled={busy}
          onClick={() => void authorize()}
        >
          <Bell size={14} />
          授权当前浏览器
        </button>
      )}
      {enabled && !available && <p role="status">当前浏览器不能显示系统通知，共享开关已保留。</p>}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
