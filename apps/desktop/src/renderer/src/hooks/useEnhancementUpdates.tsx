import { useEffect, useRef } from 'react';
import { client, trpc } from '../trpc/client';
import { useToast } from '../components/Toast.shared';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useUpdateStore } from '../state/update';
import type { EnhancementUpdateNotice } from '../../../shared/enhancement_release';

const bannerKey = 'enhancement-updates';

function updateCopy(notices: Iterable<EnhancementUpdateNotice>) {
  const names = Array.from(notices, ({ name }) => name).join('、');
  return {
    title: '增强包有可用更新',
    summary: names,
    detail: names.length > 35 ? names : undefined,
  };
}

/** 一次检查的增强包共用一张提醒；其他确认框关闭后再显示，不抢占用户操作。 */
export function useEnhancementUpdates() {
  const shown = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, EnhancementUpdateNotice>());
  const utils = trpc.useUtils();
  const packages = trpc.bootstrap.enhancementPacks.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!packages.data) return;
    const packs = packages.data.packs;
    useUpdateStore.getState().setPacksAvailable(packs.some((pack) => pack.updateAvailable));
    let changed = false;
    for (const pack of packs) {
      const notice = pending.current.get(pack.id);
      if (!notice || pack.busy) continue;
      if (
        !pack.installed ||
        (pack.ready &&
          !pack.updateAvailable &&
          (pack.installedVersion === notice.contentVersion ||
            (pack.latestVersion && pack.latestVersion === pack.installedVersion)))
      ) {
        pending.current.delete(pack.id);
        changed = true;
      }
    }
    if (!changed) return;
    const toast = useToast.getState();
    if (!pending.current.size) toast.resolve(bannerKey);
    else {
      const item = toast.toasts.find(({ key }) => key === bannerKey);
      if (item) toast.update(item.id, updateCopy(pending.current.values()));
    }
  }, [packages.data, packages.dataUpdatedAt]);
  useEffect(() => {
    const subscription = client.bootstrap.onEnhancementUpdates.subscribe(undefined, {
      onData: (notices) => {
        const updates = notices.filter(
          (notice) => shown.current.get(notice.id) !== notice.contentVersion,
        );
        if (!updates.length) return;
        for (const notice of updates) {
          shown.current.set(notice.id, notice.contentVersion);
          pending.current.set(notice.id, notice);
        }
        useToast.getState().push({
          event: 'update',
          key: bannerKey,
          ...updateCopy(pending.current.values()),
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
  }, []);
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
