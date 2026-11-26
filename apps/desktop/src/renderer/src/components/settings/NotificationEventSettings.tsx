import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, ChevronRight } from 'lucide-react';
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_LABELS,
  normalizeNotificationEvents,
  notificationGroupState,
  isScopedNotificationEvent,
  supportsNotificationChannel,
  type NotificationEvent,
  type NotificationChannel,
} from '@weq/service/notification-settings';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { Card, Toggle, QueryError } from './controls';
import { NotificationScopeEditor } from './NotificationScopeEditor';
import { useNotificationPolicy } from '../../lib/notificationPolicy';
import { IS_WEB } from '../../lib/target.shared';
import { changePreference } from '../../lib/clientPreferences';
import type { SettingsSearchTarget } from './searchTarget';
import { resolveSettingsTarget } from './navigation';
import { useExitMotion } from '../../hooks/useExitMotion';
import { TabActivity } from '../RetainedTabs';
import '../../styles/notification-event-settings.css';
import { NOTIFICATION_SETTING_IDS } from './NotificationEventSettings.shared';

function NotificationEventRows({
  expanded,
  skipEntrance,
  children,
}: {
  expanded: boolean;
  skipEntrance: boolean;
  children: () => ReactNode;
}) {
  const rows = useRef<HTMLTableSectionElement>(null);
  const present = useExitMotion(rows, expanded);
  if (!present) return null;
  return (
    <tbody
      ref={rows}
      className="weq-notification-event-rows"
      data-weq-disclosure=""
      data-closing={!expanded || undefined}
      data-instant={expanded && skipEntrance ? '' : undefined}
      inert={!expanded}
      aria-hidden={!expanded || undefined}
    >
      <TabActivity active={expanded}>{children()}</TabActivity>
    </tbody>
  );
}

export function NotificationEventSettings({
  recallScope,
  target,
}: {
  recallScope?: ReactNode;
  target?: SettingsSearchTarget | null;
}) {
  const table = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    const node = table.current;
    const scroll = node?.closest<HTMLElement>('.weq-settings-body');
    if (!node || !scroll) return;
    const update = () =>
      node.style.setProperty(
        '--weq-notification-sticky-offset',
        `-${getComputedStyle(scroll).paddingTop}`,
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  const active = useTabActive();
  const query = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.bootstrap.setNotificationEvents.useMutation();
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [locatedGroup, setLocatedGroup] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const values = normalizeNotificationEvents(query.data?.notificationEvents);
  useEffect(() => {
    if (query.data?.notificationEvents)
      useNotificationPolicy.getState().setEvents(query.data.notificationEvents);
  }, [query.data?.notificationEvents]);
  useEffect(() => {
    const settingId = target ? resolveSettingsTarget(target).settingId : undefined;
    if (!settingId) return;
    const group = NOTIFICATION_GROUPS.find((group) =>
      group.events.some(
        (event) =>
          settingId === `notification-${event}` || settingId === NOTIFICATION_SETTING_IDS[event],
      ),
    );
    if (group) {
      // 设置搜索需要在定位时读到完整行高。
      setLocatedGroup(group.id);
      setExpanded((previous) => new Set([...previous, group.id]));
    }
  }, [target]);
  const save = async (
    events: readonly NotificationEvent[],
    channel: NotificationChannel,
    enabled: boolean,
  ) => {
    const permission =
      channel === 'system' && enabled && IS_WEB && typeof Notification !== 'undefined'
        ? Notification.requestPermission()
        : null;
    const supported = events.filter((event) => supportsNotificationChannel(event, channel));
    if (saving || !supported.length) return;
    setSaving(true);
    setError('');
    try {
      const next = await mutation.mutateAsync({ events: supported, channel, enabled });
      useNotificationPolicy.getState().setEvents(next);
      utils.bootstrap.getSettings.setData(undefined, (previous) =>
        previous ? { ...previous, notificationEvents: next } : previous,
      );
      await utils.bootstrap.getSettings.invalidate();
      if (permission) {
        if ((await permission) === 'granted') await changePreference('webNotifications', true);
        else setError('当前浏览器未允许系统通知，事件设置已保存');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card
      title="事件通知"
      icon={<Bell size={15} />}
      resetId="notification-events"
      settingId="notification-events"
    >
      <table ref={table} className="weq-notification-table">
        <colgroup>
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">事件类型</th>
            <th scope="col">应用内横幅通知</th>
            <th scope="col">系统通知</th>
          </tr>
        </thead>
        {NOTIFICATION_GROUPS.map((group) => (
          <Fragment key={group.id}>
            <tbody>
              <tr className="weq-notification-group">
                <th scope="row">
                  <button
                    type="button"
                    aria-expanded={expanded.has(group.id)}
                    onClick={() => {
                      setLocatedGroup(undefined);
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      });
                    }}
                  >
                    <ChevronRight
                      size={14}
                      aria-hidden
                      className={expanded.has(group.id) ? 'is-expanded' : ''}
                    />
                    {group.label}
                  </button>
                </th>
                {(['banner', 'system'] as const).map((channel) => (
                  <td key={channel}>
                    <Toggle
                      {...notificationGroupState(group.events, channel, values)}
                      label={`${group.label}：${channel === 'banner' ? '应用内横幅通知' : '系统通知'}`}
                      disabled={!query.data || Boolean(query.error) || saving}
                      onChange={(enabled) => void save(group.events, channel, enabled)}
                    />
                  </td>
                ))}
              </tr>
            </tbody>
            <NotificationEventRows
              expanded={expanded.has(group.id)}
              skipEntrance={locatedGroup === group.id}
            >
              {() =>
                group.events.map((event) => (
                  <tr
                    key={event}
                    data-setting-id={NOTIFICATION_SETTING_IDS[event] ?? `notification-${event}`}
                    data-setting-fallback={`notification-${event}`}
                    className="weq-notification-event"
                  >
                    <th scope="row">
                      <div className="weq-disclosure-panel">
                        <div>
                          <span className="weq-notification-event-label">
                            {NOTIFICATION_LABELS[event]}
                            {isScopedNotificationEvent(event) ? (
                              <NotificationScopeEditor event={event} />
                            ) : event === 'recall' ? (
                              recallScope
                            ) : null}
                          </span>
                        </div>
                      </div>
                    </th>
                    {(['banner', 'system'] as const).map((channel) => (
                      <td key={channel}>
                        <div className="weq-disclosure-panel">
                          <div>
                            {supportsNotificationChannel(event, channel) ? (
                              <Toggle
                                checked={values[event][channel]}
                                label={`${NOTIFICATION_LABELS[event]}：${channel === 'banner' ? '应用内横幅通知' : '系统通知'}`}
                                disabled={!query.data || Boolean(query.error) || saving}
                                onChange={(enabled) => void save([event], channel, enabled)}
                              />
                            ) : null}
                          </div>
                        </div>
                      </td>
                    ))}
                  </tr>
                ))
              }
            </NotificationEventRows>
          </Fragment>
        ))}
      </table>
      {query.error && (
        <QueryError
          message={query.error.message}
          retryLabel="重试读取通知设置"
          onRetry={() => void query.refetch()}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </Card>
  );
}
