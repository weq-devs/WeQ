import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import { ReminderDot } from './ReminderBadge';
import { useToast } from './Toast.shared';
import '../styles/announcements.css';

const AnnouncementPanel = lazy(() => import('./AnnouncementPanel'));
const AnnouncementPreviewTitle = createContext<string | undefined>(undefined);
const bannerKey = 'official-announcement';

export function AnnouncementCenter({
  active,
  canOpenUpdateSettings,
  children,
}: {
  active: boolean;
  canOpenUpdateSettings: boolean;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<{ id?: string } | null>(null);
  const locked = useAppLock((state) => state.locked);
  const locallyDismissed = useRef<string | null>(null);
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
    if (active && allowed) void utils.announcements.list.invalidate();
  }, [active, allowed, utils]);

  const close = useCallback(() => setSelection(null), []);
  const open = useCallback((id?: string) => {
    if (!useAppLock.getState().locked) setSelection({ id });
  }, []);
  const unread = showBadge ? (query.data?.unread ?? 0) : 0;

  useEffect(() => {
    if (locked) close();
  }, [close, locked]);

  const reminder = active && allowed && !locked && !selection ? query.data?.reminder : null;
  const reminderId = reminder?.id;
  const title = reminder?.title;
  const summary = reminder?.summary;
  const expiresAt = reminder ? query.dataUpdatedAt + reminder.remainingMs : 0;
  useEffect(() => {
    const toast = useToast.getState();
    const remaining = expiresAt - Date.now();
    if (!reminderId || !title || remaining <= 0 || locallyDismissed.current === reminderId) {
      toast.resolve(bannerKey);
      return;
    }
    toast.push({
      appWide: true,
      event: 'officialAnnouncement',
      key: bannerKey,
      durationKind: 'long',
      title,
      summary: summary === title ? undefined : summary,
      action: { label: '查看公告', icon: 'open', run: () => open(reminderId) },
      onManualDismiss: () => {
        locallyDismissed.current = reminderId;
        void client.announcements.dismissBanner
          .mutate(reminderId)
          .catch((error: unknown) => console.warn('[announcements] 关闭提醒未同步', error));
      },
      system: false,
    });
    const timer = setTimeout(
      () => {
        toast.resolve(bannerKey);
        void utils.announcements.list.invalidate();
      },
      Math.min(remaining, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, open, reminderId, summary, title, utils]);

  return (
    <OpenAnnouncement.Provider value={open}>
      <AnnouncementUnread.Provider value={unread}>
        <AnnouncementPreviewTitle.Provider value={query.data?.entries[0]?.title}>
          {children}
        </AnnouncementPreviewTitle.Provider>
      </AnnouncementUnread.Provider>
      {selection && !locked && (
        <Suspense fallback={null}>
          <AnnouncementPanel
            selected={selection.id ?? null}
            onSelect={(id) => setSelection({ id: id ?? undefined })}
            onClose={close}
            canOpenUpdateSettings={canOpenUpdateSettings}
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
  unreadCount,
}: {
  placement: 'workspace' | 'startup' | 'mobile';
  beforeOpen?: () => void;
  unreadCount?: number;
}) {
  const { unread: presentationUnread, open } = useAnnouncementPresentation();
  const unread = unreadCount ?? presentationUnread;
  const preview = useContext(AnnouncementPreviewTitle);
  const { label, icon: Icon } = APP_NAVIGATION.announcements;
  const mobile = placement === 'mobile';
  return (
    <button
      type="button"
      className={`weq-announcement-entry is-${placement}`}
      title={preview ?? label}
      aria-label={unread ? `${label}，${unread} 条未读` : label}
      aria-description={preview}
      onClick={() => {
        beforeOpen?.();
        open();
      }}
    >
      <Icon size={mobile ? 22 : 16} aria-hidden />
      <span className="weq-announcement-entry-label">{label}</span>
      {preview && <span className="weq-announcement-entry-preview">{preview}</span>}
      {unread > 0 && <ReminderDot aria-hidden />}
      {placement !== 'startup' && <ChevronRight size={mobile ? 18 : 14} aria-hidden />}
    </button>
  );
}
