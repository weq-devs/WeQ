import { useState } from 'react';
import { Mail } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { Card, Row, SectionHeader, Toggle } from './controls';

export function MailSettingsSection() {
  const selfUin = useViewState((state) => state.openedUin);
  const input = { selfUin: selfUin ?? '' };
  const utils = trpc.useUtils();
  const preferences = trpc.mail.preferences.useQuery(input, {
    enabled: Boolean(selfUin),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const showUnread = trpc.mail.setShowUnread.useMutation();
  const notifications = trpc.mail.notifications.useMutation();
  const [error, setError] = useState('');
  const busy = showUnread.isLoading || notifications.isLoading;

  async function save(kind: 'unread' | 'notifications', enabled: boolean) {
    if (!selfUin || busy) return;
    setError('');
    try {
      if (kind === 'unread') await showUnread.mutateAsync({ selfUin, enabled });
      else
        await notifications.mutateAsync({
          selfUin,
          requestId: crypto.randomUUID(),
          enabled,
        });
    } catch (error) {
      setError(error instanceof Error ? error.message : '邮箱设置保存失败。');
    } finally {
      void utils.mail.preferences.invalidate(input);
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader icon={<Mail size={16} strokeWidth={1.8} />} title="QQ 邮箱" />
      <Card>
        <Row
          label="显示未读邮件数"
          control={
            <Toggle
              label="显示未读邮件数"
              checked={preferences.data?.showUnread ?? true}
              disabled={!selfUin || !preferences.data || busy}
              onChange={(enabled) => void save('unread', enabled)}
            />
          }
        />
        <Row
          label="新邮件提醒"
          control={
            <Toggle
              label="新邮件提醒"
              checked={preferences.data?.notifications ?? false}
              disabled={!selfUin || !preferences.data || busy}
              onChange={(enabled) => void save('notifications', enabled)}
            />
          }
        />
      </Card>
      {error || preferences.error ? (
        <p className="weq-set-note" role="alert">
          {error || preferences.error?.message}
        </p>
      ) : null}
    </div>
  );
}
