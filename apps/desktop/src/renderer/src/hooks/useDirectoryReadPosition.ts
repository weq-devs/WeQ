import { useEffect } from 'react';
import {
  validReadPosition,
  newerReadPosition,
  directoryUnreadKey,
  isQqDirectoryReadKey,
} from '@weq/service/client-preferences';
import { trpc } from '../trpc/client';
import { useQQReadActivity } from './useQQAutoRefresh';
import { useStableCallback } from './useStableCallback';
import {
  isAccountStateReady,
  saveAccountRecords,
  sharedAccountRecords,
  useClientPreferences,
} from '../lib/clientPreferences';

/** 仅推进实际可见内容的水位，不把选择入口或后台生成当成阅读。 */
export function useDirectoryReadPosition(
  key: string,
  position: string,
  active = true,
  unreadPosition?: string,
) {
  const { enabled } = useQQReadActivity(active, { onlineOnly: false });
  const ready = useClientPreferences(isAccountStateReady);
  const qqRead = isQqDirectoryReadKey(key);
  const mode = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: false,
    select: (settings) => settings.qqCapabilityMode,
  });
  const settingsReady = !qqRead || mode.data !== undefined;
  const canAdvance = useStableCallback(() => !qqRead || (mode.data && mode.data !== 'read-only'));
  // 目录刷新不算再次阅读，避免覆盖会话打开后手动留下的未读标记。
  const directoryReportsUnread = useStableCallback(
    () => position !== '0' && position === unreadPosition,
  );
  useEffect(() => {
    if (!enabled || !key || !validReadPosition(position) || !ready || !canAdvance()) return;
    const reads = sharedAccountRecords('reads');
    const previous = String(reads[key] ?? '0');
    const marker = reads[directoryUnreadKey(key)];
    if (
      newerReadPosition(position, previous) ||
      (position === previous && marker) ||
      (key.startsWith('official:') && position !== '0') ||
      directoryReportsUnread()
    )
      saveAccountRecords('reads', {
        [key]: { position, ...(typeof marker === 'string' ? { marker } : {}) },
      });
  }, [enabled, key, position, ready, settingsReady, directoryReportsUnread, canAdvance]);
}
