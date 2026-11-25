import { useContext, useMemo, type ReactNode } from 'react';
import type { AppSearchTarget } from '../components/search/appSearchCatalog';
import {
  type NotificationSource,
  NotificationSourceContext,
  notificationSource,
} from './notificationNavigation.shared';

export function NotificationSourceProvider({
  source,
  children,
}: {
  source: NotificationSource | null;
  children?: ReactNode;
}) {
  return (
    <NotificationSourceContext.Provider value={source}>
      {children}
    </NotificationSourceContext.Provider>
  );
}

export function SettingsNotificationSource({
  section,
  children,
}: {
  section: Extract<AppSearchTarget, { kind: 'setting' }>['section'];
  children?: ReactNode;
}) {
  const inherited = useContext(NotificationSourceContext);
  const binding = [
    'account',
    'credentials',
    'qq-accounts',
    'diagnostics',
    'database-management',
    'qq-storage',
  ].includes(section)
    ? (inherited?.binding ?? undefined)
    : null;
  const source = useMemo(
    () =>
      notificationSource(
        { kind: 'app', target: { kind: 'setting', section } },
        '返回对应设置',
        binding,
      ),
    [section, binding],
  );
  return <NotificationSourceProvider source={source}>{children}</NotificationSourceProvider>;
}
export type { NotificationSource, NotificationTarget } from './notificationNavigation.shared';
