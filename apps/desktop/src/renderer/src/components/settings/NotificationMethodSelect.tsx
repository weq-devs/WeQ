import { FormSelect } from '../FormSelect';
import { useId, useRef, useState } from 'react';
import { NOTIFICATION_LABELS, type NotificationEvent } from '@weq/service/notification-settings';
import {
  NOTIFICATION_METHODS,
  notificationMethodOf,
  type NotificationMethod,
} from '../../../../shared/notification_method';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { useNotificationPolicy } from '../../lib/notificationPolicy';
import { changePreference } from '../../lib/clientPreferences';
import { IS_WEB } from '../../lib/target.shared';
import { QueryError } from './controls';
import '../../styles/notification-method-select.css';

export function NotificationMethodSelect({ event }: { event: NotificationEvent }) {
  const active = useTabActive();
  const query = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.bootstrap.setNotificationEvents.useMutation();
  const utils = trpc.useUtils();
  const saving = useRef(false);
  const revision = useRef(0);
  const [pending, setPending] = useState<NotificationMethod | null>(null);
  const [error, setError] = useState('');
  const errorId = useId();
  const channels = query.data?.notificationEvents[event];
  const label = `${NOTIFICATION_LABELS[event]}通知方式`;

  async function save(method: (typeof NOTIFICATION_METHODS)[number]) {
    if (saving.current || !channels || method.value === notificationMethodOf(channels)) return;
    const request = ++revision.current;
    saving.current = true;
    setPending(method.value);
    setError('');
    const permission = (() => {
      if (!IS_WEB || !method.channels.system) return null;
      if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
      try {
        return Notification.requestPermission().catch(() => 'denied');
      } catch {
        return Promise.resolve('denied');
      }
    })();
    try {
      const next = await mutation.mutateAsync({ events: [event], channels: method.channels });
      useNotificationPolicy.getState().setEvents(next);
      utils.bootstrap.getSettings.setData(undefined, (previous) =>
        previous ? { ...previous, notificationEvents: next } : previous,
      );
      void utils.bootstrap.getSettings.invalidate();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(`保存失败：${message}`);
      return;
    } finally {
      saving.current = false;
      setPending(null);
    }
    // 授权与共享设置独立完成，不能占用已经保存完的下拉框。
    if (!permission) return;
    try {
      const result = await permission;
      if (request !== revision.current) return;
      if (result === 'granted') {
        const enabled = await changePreference('webNotifications', true);
        if (!enabled && request === revision.current)
          setError('通知方式已保存，但当前浏览器通知的启用偏好未保存，请重试。');
      } else {
        setError(
          result === 'unsupported'
            ? '通知方式已保存，当前浏览器不支持系统通知。'
            : '通知方式已保存，当前浏览器未允许系统通知。',
        );
      }
    } catch (reason) {
      if (request !== revision.current) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(`通知方式已保存，但启用当前浏览器通知失败：${message}`);
    }
  }

  return (
    <div className="weq-notification-method">
      <FormSelect
        className="weq-set-input weq-notification-method-select"
        aria-label={label}
        aria-busy={pending !== null}
        aria-describedby={error || query.error ? errorId : undefined}
        value={pending ?? (channels ? notificationMethodOf(channels) : '')}
        disabled={!channels || Boolean(query.error) || pending !== null}
        onChange={(change) => {
          const method = NOTIFICATION_METHODS.find((item) => item.value === change.target.value);
          if (method) void save(method);
        }}
      >
        {!channels && <option value="">{query.error ? '读取失败' : '正在读取…'}</option>}
        {NOTIFICATION_METHODS.map((method) => (
          <option key={method.value} value={method.value}>
            {method.label}
          </option>
        ))}
      </FormSelect>
      {query.error ? (
        <div id={errorId}>
          <QueryError
            message={query.error.message}
            retryLabel={`重新读取${label}`}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : error ? (
        <p id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
