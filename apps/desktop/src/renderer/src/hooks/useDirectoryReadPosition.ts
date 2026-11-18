import { useEffect } from 'react';
import { validReadPosition, newerReadPosition } from '@weq/service/client-preferences';
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
  const tick = useClientPreferences((state) => state.tick);
  useEffect(() => {
    if (!enabled || !key || !validReadPosition(position) || !isAccountStateReady()) return;
    const previous = String(sharedAccountRecords('reads')[key] ?? '0');
    if (newerReadPosition(position, previous)) saveAccountRecords('reads', { [key]: position });
  }, [enabled, key, position, tick]);
}
