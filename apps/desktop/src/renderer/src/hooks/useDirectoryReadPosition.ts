import { useEffect } from 'react';
import {
  validReadPosition,
  newerReadPosition,
  directoryUnreadKey,
} from '@weq/service/client-preferences';
import { useQQReadActivity } from './useQQAutoRefresh';
import {
  isAccountStateReady,
  saveAccountRecords,
  sharedAccountRecords,
  useClientPreferences,
} from '../lib/clientPreferences';

/** 仅推进实际可见内容的水位，不把选择入口或后台生成当成阅读。 */
export function useDirectoryReadPosition(key: string, position: string, active = true) {
  const { enabled } = useQQReadActivity(active, { onlineOnly: false });
  const ready = useClientPreferences(isAccountStateReady);
  useEffect(() => {
    if (!enabled || !key || !validReadPosition(position) || !ready) return;
    const reads = sharedAccountRecords('reads');
    const previous = String(reads[key] ?? '0');
    const marker = reads[directoryUnreadKey(key)];
    if (newerReadPosition(position, previous) || (position === previous && marker))
      saveAccountRecords('reads', {
        [key]: typeof marker === 'string' ? { position, marker } : position,
      });
  }, [enabled, key, position, ready]);
}
