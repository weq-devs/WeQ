import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useAppLock } from '../state/lock';
import { APP_NAVIGATION } from '../lib/appNavigation';
import {
  AnnouncementUnread,
  OpenAnnouncement,
  useAnnouncementPresentation,
} from '../lib/announcementPresentation';
import { preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import { useNotificationPolicy } from '../lib/notificationPolicy';
import { ReminderCount } from './ReminderBadge';
import { useToast } from './Toast.shared';
import '../styles/announcements.css';

const AnnouncementPanel = lazy(() => import('./AnnouncementPanel'));
const bannerKey = 'official-announcement';
const inForeground = () =>
  document.visibilityState === 'visible' &&
  document.hasFocus() &&
  !document.body.classList.contains('weq-tool-window');

export function AnnouncementCenter({ active, children }: { active: boolean; children: ReactNode }) {
  const [selection, setSelection] = useState<{ id?: string } | null>(null);
  const locked = useAppLock((state) => state.locked);
  const [focused, setFocused] = useState(inForeground);
  const inFlight = useRef(false);
  const shown = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const allowed = useNotificationPolicy(
    (state) => state.ready && state.events.officialAnnouncement.banner,
  );
  const showBadge = useClientPreferences(() => preferenceValue('showOfficialAnnouncementBadge'));
  const utils = trpc.useUtils();
  const query = trpc.announcements.list.useQuery(undefined, {
    enabled: active,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
  });
  trpc.announcements.changed.useSubscription(undefined, {
    enabled: active,
    onData: () => {
      void utils.announcements.list.invalidate();
      void utils.announcements.detail.invalidate();
    },
  });

  useEffect(() => {
    const update = () => setFocused(inForeground());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const close = useCallback(() => setSelection(null), []);
  const open = useCallback((id?: string) => {
    if (!useAppLock.getState().locked) setSelection({ id });
  }, []);
  const unread = showBadge ? (query.data?.unread ?? 0) : 0;

  const clearBanner = useCallback(() => {
    if (shown.current) clearTimeout(shown.current.timer);
    shown.current = null;
    useToast.getState().resolve(bannerKey);
  }, []);
  useEffect(() => clearBanner, [clearBanner]);
  useEffect(() => {
    if (locked) close();
    if (
      !active ||
      locked ||
      !allowed ||
      (shown.current &&
        query.data &&
        !query.data.entries.some(
          ({ id, unread, level }) => id === shown.current?.id && unread && level === 'important',
        ))
    )
      clearBanner();
  }, [active, allowed, clearBanner, close, locked, query.data]);

  const canPresent = active && !locked && allowed && focused && !selection;
  const presenting = useRef(canPresent);
  presenting.current = canPresent;
  const candidate = query.data?.reminder;
  useEffect(() => {
    if (
      !candidate ||
      !canPresent ||
      inFlight.current ||
      !inForeground() ||
      useToast.getState().toasts.some(({ key }) => key === bannerKey)
    )
      return;
    const start = performance.now();
    inFlight.current = true;
    void client.announcements.claimBanner
      .mutate(candidate)
      .then(async (lease) => {
        if (!lease) return;
        const elapsed = performance.now() - start;
        const entries = utils.announcements.list.getData()?.entries;
        const show =
          presenting.current &&
          inForeground() &&
          elapsed < Math.min(lease.leaseMs, lease.remainingMs) &&
          Boolean(entries?.some(({ id, unread }) => id === candidate && unread));
        if (show) {
          clearBanner();
          useToast.getState().push({
            event: 'officialAnnouncement',
            key: bannerKey,
            title: lease.title,
            action: { label: '查看公告', icon: 'open', run: () => open(candidate) },
            system: false,
            source: null,
          });
          shown.current = {
            id: candidate,
            timer: setTimeout(clearBanner, Math.min(lease.remainingMs - elapsed, 2_147_483_647)),
          };
        }
        await client.announcements.finishBanner.mutate({ token: lease.token, shown: show });
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
  }, [candidate, canPresent, clearBanner, open, query.dataUpdatedAt, utils]);

  return (
    <OpenAnnouncement.Provider value={open}>
      <AnnouncementUnread.Provider value={unread}>{children}</AnnouncementUnread.Provider>
      {selection && !locked && (
        <Suspense fallback={null}>
          <AnnouncementPanel
            selected={selection.id ?? null}
            onSelect={(id) => setSelection({ id: id ?? undefined })}
            onClose={close}
            list={query.data}
            listFailed={query.isError}
          />
        </Suspense>
      )}
    </OpenAnnouncement.Provider>
  );
}

export function AnnouncementEntry({
  placement,
  beforeOpen,
}: {
  placement: 'workspace' | 'startup';
  beforeOpen?: () => void;
}) {
  const { unread, open } = useAnnouncementPresentation();
  const { label, icon: Icon } = APP_NAVIGATION.announcements;
  return (
    <button
      type="button"
      className={`weq-announcement-entry is-${placement}`}
      title={label}
      aria-label={unread ? `${label}，${unread} 条未读` : label}
      onClick={() => {
        beforeOpen?.();
        open();
      }}
    >
      <Icon size={16} aria-hidden />
      <span className="weq-announcement-entry-label">{label}</span>
      <ReminderCount count={unread} aria-hidden />
      {placement === 'workspace' && (
        <ChevronRight className="weq-announcement-entry-arrow" size={14} aria-hidden />
      )}
    </button>
  );
}
