import { useState } from 'react';
import {
  conversationNotificationOverride,
  GROUP_ONLY_NOTIFICATION_EVENTS,
  mutedFromNotifyLevel,
  normalizeNotificationScope,
  NOTIFICATION_LABELS,
  notificationOverrideKey,
  notificationScopeIncludes,
  notificationScopeUsesConversationState,
  SCOPED_NOTIFICATION_EVENTS,
  type NotificationEvent,
  type ScopedNotificationEvent,
} from '@weq/service/notification-settings';
import { NOTIFICATION_METHODS, notificationMethodOf } from '../../../shared/notification_method';
import {
  accountBinding,
  currentAccountScope,
  isAccountStateReady,
  patchAccountRecords,
  useAccountRecords,
  useClientPreferences,
} from '../lib/clientPreferences';
import { useNotificationPolicy } from '../lib/notificationPolicy';
import { trpc } from '../trpc/client';
import { Card, QueryError, Row, Toggle } from './settings/controls';
import { NotificationSettingsLink } from './settings/NotificationSettingsLink';

const privateEvents = SCOPED_NOTIFICATION_EVENTS.filter(
  (event) => !GROUP_ONLY_NOTIFICATION_EVENTS.has(event),
);

export function ConversationNotificationSettings({
  kind,
  conv,
  notificationState,
  onClose,
  recall,
}: {
  kind: 'c2c' | 'group' | 'dataline';
  conv: string;
  notificationState?: { muted: boolean; groupAssistant: boolean };
  onClose: () => void;
  recall: {
    checked: boolean;
    protectedHere: boolean;
    disabled: boolean;
    onChange: (next: boolean) => Promise<void>;
  };
}) {
  const binding = accountBinding();
  const accountScope = currentAccountScope();
  const records = useAccountRecords('notifications', accountScope);
  const accountReady = useClientPreferences(isAccountStateReady);
  const ready = Boolean(binding) && accountReady;
  const policy = useNotificationPolicy();
  const [saving, setSaving] = useState<Partial<Record<ScopedNotificationEvent, boolean>>>({});
  const [error, setError] = useState('');
  const key = `${kind}:${conv}`;
  const scopedEvents =
    kind === 'group' ? SCOPED_NOTIFICATION_EVENTS : kind === 'c2c' ? privateEvents : [];
  const rows = scopedEvents.map((event) => ({
    event,
    scope: normalizeNotificationScope(records[event]),
    override: conversationNotificationOverride(records, event, key),
  }));
  const needPeerState =
    !notificationState &&
    ready &&
    rows.some(({ scope }) => notificationScopeUsesConversationState(scope));
  const peer = trpc.account.qqWrite.peerState.useQuery(
    {
      expectedAccountUin: binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: binding?.expectedAccountConfigId ?? '',
      target: kind === 'group' ? { kind, groupId: Number(conv) } : { kind: 'c2c', uid: conv },
    },
    { enabled: needPeerState, refetchOnWindowFocus: false },
  );
  const state =
    notificationState ??
    (peer.data && {
      muted: mutedFromNotifyLevel(peer.data.notifyLevel ?? undefined),
      groupAssistant: kind === 'group' && peer.data.notifyLevel === 2,
    });
  const ordinary = kind === 'group' ? 'groupMessage' : 'directMessage';

  function method(event: NotificationEvent) {
    if (!policy.ready) return '全局：正在读取…';
    const value = notificationMethodOf(policy.events[event]);
    const option = NOTIFICATION_METHODS.find((item) => item.value === value);
    return `全局：${(option ?? NOTIFICATION_METHODS[0]).label}`;
  }

  async function save(
    event: ScopedNotificationEvent,
    next: boolean,
    defaultIncluded: boolean | undefined,
  ) {
    if (!ready || currentAccountScope() !== accountScope) return;
    setSaving((previous) => ({ ...previous, [event]: true }));
    setError('');
    try {
      await patchAccountRecords('notifications', {
        [notificationOverrideKey(event, key)]: next === defaultIncluded ? null : next,
      });
    } catch (reason) {
      setError(
        `${NOTIFICATION_LABELS[event]}提醒未保存：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setSaving((previous) => ({ ...previous, [event]: false }));
    }
  }

  return (
    <div className="weq-cvs-body-scroll">
      <Card
        action={
          <NotificationSettingsLink settingId="notification-events" onNavigate={onClose}>
            前往通知设置
          </NotificationSettingsLink>
        }
      >
        {kind !== 'dataline' && (
          <Row label={NOTIFICATION_LABELS[ordinary]} desc={method(ordinary)} control={null} />
        )}
        {rows.map(({ event, scope, override }) => {
          const defaultIncluded =
            state || !notificationScopeUsesConversationState(scope)
              ? notificationScopeIncludes(scope, {
                  key,
                  muted: false,
                  groupAssistant: false,
                  ...state,
                })
              : undefined;
          const checked = ready ? (override ?? defaultIncluded) : undefined;
          return (
            <Row
              key={event}
              label={NOTIFICATION_LABELS[event]}
              desc={method(event)}
              control={
                <Toggle
                  label={`本会话${NOTIFICATION_LABELS[event]}提醒`}
                  checked={checked ?? false}
                  indeterminate={checked === undefined}
                  disabled={checked === undefined || saving[event]}
                  onChange={(next) => void save(event, next, defaultIncluded)}
                />
              }
            />
          );
        })}
        <Row
          label={NOTIFICATION_LABELS.recall}
          desc={
            recall.checked && !recall.protectedHere
              ? `${method('recall')}；本会话未开启防撤回`
              : method('recall')
          }
          control={
            <Toggle
              label="本会话撤回提醒"
              checked={recall.checked}
              disabled={recall.disabled}
              onChange={(next) => void recall.onChange(next)}
            />
          }
        />
        {needPeerState && peer.error && (
          <QueryError
            message={peer.error.message}
            retryLabel="重新读取会话状态"
            retrying={peer.isFetching}
            onRetry={() => void peer.refetch()}
          />
        )}
        {error && (
          <p className="weq-set-note" role="alert">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}
