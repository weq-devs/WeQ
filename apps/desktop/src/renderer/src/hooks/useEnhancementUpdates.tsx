import { useEffect, useRef } from 'react';
import { client, trpc } from '../trpc/client';
import { useToast } from '../components/Toast.shared';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useUpdateStore } from '../state/update';

/** 一次检查的增强包共用一张提醒；其他确认框关闭后再显示，不抢占用户操作。 */
export function useEnhancementUpdates() {
  const shown = useRef(new Map<string, string>());
  const pendingNames = useRef(new Map<string, string>());
  const utils = trpc.useUtils();
  const packages = trpc.bootstrap.enhancementPacks.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (packages.data)
      useUpdateStore
        .getState()
        .setPacksAvailable(packages.data.packs.some((pack) => pack.updateAvailable));
  }, [packages.data]);
  useEffect(() => {
    const subscription = client.bootstrap.onEnhancementUpdates.subscribe(undefined, {
      onData: (notices) => {
        void utils.bootstrap.enhancementPacks.invalidate();
        const updates = notices.filter(
          (notice) => shown.current.get(notice.id) !== notice.contentVersion,
        );
        if (!updates.length) return;
        for (const notice of updates) {
          shown.current.set(notice.id, notice.contentVersion);
          pendingNames.current.set(notice.id, notice.name);
        }
        useToast.getState().push({
          event: 'update',
          key: 'enhancement-updates',
          title: '增强包有可用更新',
          detail: [...pendingNames.current.values()].join('、'),
          action: { label: '前往增强包', run: () => requestOpenSettings('enhancementPacks') },
        });
        void client.bootstrap.acknowledgeEnhancementUpdates
          .mutate(updates.map(({ id, contentVersion }) => ({ id, contentVersion })))
          .catch((error: unknown) =>
            console.error('[enhancements] notification acknowledgement failed', error),
          );
      },
      onError: (error) => console.error('[enhancements] notification subscription error', error),
    });
    return () => subscription.unsubscribe();
  }, [utils]);
}
