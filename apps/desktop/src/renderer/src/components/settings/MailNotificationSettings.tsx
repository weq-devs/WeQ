import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { Row, Toggle, QueryError } from './controls';

export function MailNotificationSettings({ kind }: { kind: 'notifications' | 'unread' }) {
  const active = useTabActive();
  const query = trpc.settings.mail.get.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.settings.mail.patch.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const unread = kind === 'unread';
  const label = unread ? '邮箱导航未读角标' : '新邮件提醒';
  return (
    <>
      <Row
        settingId={unread ? 'mail-unread-badge' : 'mail-banner'}
        label={label}
        desc={unread ? undefined : '控制新邮件横幅和系统通知；关闭后仍按查询间隔更新未读状态。'}
        control={
          <Toggle
            label={label}
            checked={
              unread ? (query.data?.showUnread ?? true) : (query.data?.notifications ?? false)
            }
            disabled={!query.data || Boolean(query.error) || saving}
            onChange={(enabled) => {
              setError('');
              setSaving(true);
              void mutation
                .mutateAsync(unread ? { showUnread: enabled } : { notifications: enabled })
                .then(() => utils.settings.mail.get.invalidate())
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : String(reason)),
                )
                .finally(() => setSaving(false));
            }}
          />
        }
      />
      {query.error && (
        <QueryError
          message={query.error.message}
          retryLabel="重试读取邮件提醒设置"
          onRetry={() => void query.refetch()}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
