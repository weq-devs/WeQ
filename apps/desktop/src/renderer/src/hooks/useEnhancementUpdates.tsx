import { useEffect, useRef } from 'react';
import { client, trpc } from '../trpc/client';
import { useToast } from '../components/Toast.shared';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useUpdateStore } from '../state/update';
import type { EnhancementUpdateNotice } from '../../../shared/enhancement_release';

const bannerKey = 'enhancement-updates';
const openSettings = () => requestOpenSettings('enhancementPacks');

export function useEnhancementUpdates(open = openSettings) {
  const pending = useRef<EnhancementUpdateNotice[]>([]);
  const utils = trpc.useUtils();
  const packages = trpc.bootstrap.enhancementPacks.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!packages.data) return;
    const { packs } = packages.data;
    useUpdateStore.getState().setPacksAvailable(packs.some((pack) => pack.updateNeedsAttention));
  }, [packages.data, packages.dataUpdatedAt]);
  useEffect(() => {
    const subscription = client.bootstrap.onEnhancementUpdates.subscribe(undefined, {
      onData: (notices) => {
        const previous = pending.current;
        if (
          previous.length === notices.length &&
          notices.every(
            (notice, index) =>
              previous[index]?.id === notice.id &&
              previous[index]?.contentVersion === notice.contentVersion,
          )
        )
          return;
        pending.current = notices;
        const toast = useToast.getState();
        if (!notices.length) {
          toast.resolve(bannerKey);
          return;
        }
        const names = notices.map(({ name }) => name).join('、');
        const acknowledge = () => {
          void client.bootstrap.acknowledgeEnhancementUpdates
            .mutate(notices.map(({ id, contentVersion }) => ({ id, contentVersion })))
            .catch((error: unknown) =>
              console.error('[enhancements] notification acknowledgement failed', error),
            );
        };
        toast.push({
          appWide: true,
          event: 'update',
          key: bannerKey,
          durationKind: 'long',
          title: '增强包有可用更新',
          summary: names,
          detail: names.length > 35 ? names : undefined,
          onManualDismiss: acknowledge,
          action: {
            label: '前往增强包',
            run: () => {
              acknowledge();
              open();
            },
          },
        });
      },
      onError: (error) => console.error('[enhancements] notification subscription error', error),
    });
    return () => subscription.unsubscribe();
  }, [open]);
  useEffect(() => {
    const refreshPacks = async () => {
      // 首次读取若仍在途，不能复用可能早于变更的旧请求。
      await utils.bootstrap.enhancementPacks.cancel();
      await utils.bootstrap.enhancementPacks.invalidate();
    };
    const subscription = client.bootstrap.onEnhancementStateChanged.subscribe(undefined, {
      onData: (change) => {
        void refreshPacks();
        if (change.kind !== 'snapshot' && change.kind !== 'resources') return;
        const id = 'id' in change ? change.id : undefined;
        if (!id || id === 'text' || id === 'voice' || id === 'intent') {
          void utils.bootstrap.localModelResources.invalidate();
          if (id !== 'voice') {
            void utils.bootstrap.getLocalEngine.invalidate();
            void utils.settings.intent.getStatus.invalidate();
            void utils.account.intentSense.getStatus.invalidate();
          }
        }
        if (!id || id === 'dress') void utils.account.dressup.getState.invalidate();
      },
      onError: (error) => console.error('[enhancements] state subscription error', error),
    });
    return () => subscription.unsubscribe();
  }, [utils]);
}
