import { formatDateTime } from '@weq/time';
import { TimeLabel } from '../TimeLabel';
import { useState } from 'react';
import { BellRing, Mail } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { useTabActive } from '../RetainedTabs';
import {
  DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
  MAX_MAIL_POLL_INTERVAL_MINUTES,
} from '@weq/service/mail-wire';
import { AutoSave } from './AutoSave';
import { useNumericSettingDraft } from './useNumericSettingDraft';

function lastSyncText(lastSync: number | null | undefined): string | null {
  if (!lastSync) return null;
  return formatDateTime(lastSync);
}

export function MailSettingsSection() {
  const active = useTabActive();
  const utils = trpc.useUtils();
  const preferences = trpc.settings.mail.get.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const showUnread = trpc.settings.mail.patch.useMutation();
  const notifications = trpc.settings.mail.patch.useMutation();
  const pollInterval = trpc.settings.mail.patch.useMutation();
  const savedInterval = preferences.data?.pollIntervalMinutes;
  const [minutes, setMinutes] = useNumericSettingDraft(
    'mail:poll-interval',
    savedInterval,
    DEFAULT_MAIL_POLL_INTERVAL_MINUTES,
  );
  const interval = Number(minutes);
  const validInterval =
    minutes.trim() !== '' &&
    Number.isInteger(interval) &&
    interval >= 1 &&
    interval <= MAX_MAIL_POLL_INTERVAL_MINUTES;
  const [error, setError] = useState('');
  const busy = showUnread.isLoading || notifications.isLoading;
  const lastSync = lastSyncText(preferences.data?.lastSync);

  async function save(kind: 'unread' | 'notifications', enabled: boolean) {
    if (busy) return;
    setError('');
    try {
      if (kind === 'unread') await showUnread.mutateAsync({ showUnread: enabled });
      else
        await notifications.mutateAsync({
          notifications: enabled,
        });
    } catch (error) {
      setError(error instanceof Error ? error.message : '邮箱设置保存失败。');
    } finally {
      void utils.settings.mail.get.invalidate();
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader icon={<Mail size={16} strokeWidth={1.8} />} title="QQ 邮箱" badge="自动保存" />
      <Card title="邮箱同步与提醒" icon={<BellRing size={15} strokeWidth={1.8} />} resetId="mail">
        <AutoSave
          value={minutes.trim() ? interval : ''}
          saved={savedInterval ?? DEFAULT_MAIL_POLL_INTERVAL_MINUTES}
          ready={savedInterval !== undefined}
          valid={validInterval}
          resetKeys={['poll-interval']}
          reset={() => setMinutes(String(savedInterval ?? DEFAULT_MAIL_POLL_INTERVAL_MINUTES))}
          save={async (value) => {
            await pollInterval.mutateAsync({ pollIntervalMinutes: Number(value) });
            await utils.settings.mail.get.invalidate();
          }}
        >
          <Row
            settingId="mail-poll-interval"
            label="邮件查询间隔"
            desc={
              <>
                默认 1 分钟，可设 1–{MAX_MAIL_POLL_INTERVAL_MINUTES}{' '}
                分钟。按这个间隔在后台查询新邮件， 与是否已有未读无关；改动后立即生效。
                {lastSync ? (
                  <>
                    上次查询：
                    <TimeLabel value={preferences.data?.lastSync} precision="millisecond">
                      {lastSync}
                    </TimeLabel>
                    。
                  </>
                ) : (
                  '还没有查询过。'
                )}
              </>
            }
            control={
              <span className="weq-set-unit-field">
                <input
                  type="number"
                  className="weq-set-input"
                  aria-label="邮件查询间隔（分钟）"
                  min={1}
                  max={MAX_MAIL_POLL_INTERVAL_MINUTES}
                  step={1}
                  required
                  value={minutes}
                  disabled={savedInterval === undefined}
                  onChange={(event) => setMinutes(event.target.value)}
                />
                <span className="weq-set-unit">分钟</span>
              </span>
            }
          />
        </AutoSave>
        <Row
          settingId="mail-unread-badge"
          label="在邮箱图标上显示红点"
          desc="有新邮件时在邮箱图标上显示红点，与下面的横幅提醒互相独立。"
          control={
            <Toggle
              label="在邮箱图标上显示红点"
              checked={preferences.data?.showUnread ?? true}
              disabled={!preferences.data || busy}
              onChange={(enabled) => void save('unread', enabled)}
            />
          }
        />
        <Row
          settingId="mail-banner"
          label="收到新邮件时横幅提醒"
          desc="关闭后仍在后台按上面的间隔查询并更新未读状态，只是不再弹出横幅。"
          control={
            <Toggle
              label="收到新邮件时横幅提醒"
              checked={preferences.data?.notifications ?? false}
              disabled={!preferences.data || busy}
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
