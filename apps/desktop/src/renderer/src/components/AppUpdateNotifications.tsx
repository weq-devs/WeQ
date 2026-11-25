import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { client } from '../trpc/client';
import { useEnhancementUpdates } from '../hooks/useEnhancementUpdates';
import { notificationSource, openNotificationSource } from '../lib/notificationNavigation.shared';
import { IS_WEB } from '../lib/target.shared';
import { useAccountSwitch } from '../state/accountSwitch';
import { useUpdateStore } from '../state/update';
import { useViewState } from '../state/view';
import { Modal } from './Dialog';
import { PageShell } from './PageShell';
import { useToast } from './Toast.shared';

const UpdateCard = lazy(() =>
  import('./settings/UpdateCard').then((m) => ({ default: m.UpdateCard })),
);
const EnhancementPacks = lazy(() =>
  import('./settings/EnhancementPacksSection').then((m) => ({
    default: m.EnhancementPacksSection,
  })),
);

type Section = 'version' | 'enhancement-packs';

export function AppUpdateNotifications() {
  const [dialog, setDialog] = useState<Section | null>(null);
  const open = useCallback((section: Section) => {
    if (useViewState.getState().view === 'main' && !useAccountSwitch.getState().active)
      openNotificationSource(
        notificationSource({ kind: 'app', target: { kind: 'setting', section } }, '查看更新', null),
      );
    else setDialog(section);
  }, []);
  const openPacks = useCallback(() => open('enhancement-packs'), [open]);
  const close = useCallback(() => setDialog(null), []);
  useEnhancementUpdates(openPacks);

  useEffect(() => {
    if (IS_WEB) return;
    const key = 'weq-update';
    const events = client.update.onEvent.subscribe(undefined, {
      onData: (event) => {
        if (event.kind === 'availability')
          useUpdateStore.getState().setSoftwareAvailable(event.available);
      },
    });
    const banners = client.update.onBanner.subscribe(undefined, {
      onData: (banner) => {
        const toast = useToast.getState();
        if (!banner) {
          toast.resolve(key);
          return;
        }
        const dismiss = () => {
          void client.update.dismissBanner
            .mutate(banner)
            .catch((error: unknown) => console.warn('[update] 关闭提醒未同步', error));
        };
        toast.push({
          appWide: true,
          onManualDismiss: dismiss,
          event: 'update',
          key,
          durationKind: 'long',
          title:
            banner.kind === 'downloaded'
              ? `WeQ ${banner.latest} 已下载`
              : `WeQ ${banner.latest} 可更新`,
          action: {
            label: '查看软件更新',
            run: () => {
              dismiss();
              open('version');
            },
          },
        });
      },
    });
    return () => {
      events.unsubscribe();
      banners.unsubscribe();
    };
  }, [open]);

  if (!dialog) return null;
  const title = dialog === 'version' ? '软件更新' : '增强包';
  return (
    <Modal width={560} onClose={close} centered labelledBy="weq-app-update-title">
      <PageShell title={title} titleId="weq-app-update-title" onClose={close}>
        <Suspense fallback={null}>
          {dialog === 'version' ? <UpdateCard /> : <EnhancementPacks />}
        </Suspense>
      </PageShell>
    </Modal>
  );
}
