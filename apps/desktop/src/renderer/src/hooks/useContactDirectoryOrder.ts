import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContactMetric, ContactMetricRows } from '@weq/service';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { contactCacheFields, shouldOfferContactRefresh } from '../lib/contactCachePolicy';
import {
  defaultDescending,
  FRIEND_GROUPS,
  FRIEND_SORTS,
  GROUP_GROUPS,
  GROUP_SORTS,
  type DirectoryPreferences,
  type RegionNode,
} from '../lib/contactListOrder';
const EMPTY_ROWS: ContactMetricRows = {};
const EMPTY_REGIONS: RegionNode[] = [];

export function useContactDirectoryOrder(
  kind: 'friends' | 'groups',
  freeze: boolean,
  entities: readonly (readonly string[])[],
) {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  const binding = useMemo(
    () => ({ expectedAccountUin: uin ?? '', expectedAccountConfigId: configId ?? '' }),
    [uin, configId],
  );
  const enabled = Boolean(uin && configId);
  const snapshot = trpc.account.contactMetrics.snapshot.useQuery(binding, {
    enabled,
    staleTime: 5000,
    keepPreviousData: false,
  });
  const utils = trpc.useUtils();
  trpc.account.contactMetrics.changed.useSubscription(binding, {
    enabled,
    onData: (event) => {
      void utils.account.contactMetrics.snapshot.invalidate(binding);
      if (event.base) {
        void utils.account.listProfiles.invalidate();
        void utils.account.listBuddies.invalidate();
        void utils.account.listCategories.invalidate();
        void utils.account.listAllGroups.invalidate();
      }
    },
  });
  const groupingOptions = kind === 'friends' ? FRIEND_GROUPS : GROUP_GROUPS;
  const sortOptions = kind === 'friends' ? FRIEND_SORTS : GROUP_SORTS;
  const defaults = useMemo<DirectoryPreferences>(
    () => ({ grouping: kind === 'friends' ? 'qq' : 'notify', sort: 'remark', descending: false }),
    [kind],
  );
  const storageKey = `weq.contacts.order.${configId ?? ''}.${uin ?? ''}.${kind}`;
  const [saved, setSaved] = useState<{ key: string; value: DirectoryPreferences }>();
  const [refreshRequest, setRefreshRequest] = useState<{
    fields: ContactMetric[];
    scope: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let value = defaults;
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (
        parsed &&
        Object.hasOwn(groupingOptions, parsed.grouping) &&
        Object.hasOwn(sortOptions, parsed.sort) &&
        typeof parsed.descending === 'boolean'
      )
        value = parsed;
    } catch {
      /* 缺少偏好时使用默认值。 */
    }
    setSaved({ key: storageKey, value });
  }, [storageKey, enabled, defaults, groupingOptions, sortOptions]);
  const preferences = saved?.key === storageKey ? saved.value : defaults;
  const change = (patch: Partial<DirectoryPreferences>) => {
    const fields =
      patch.sort && patch.sort !== preferences.sort
        ? contactCacheFields('sort', patch.sort)
        : patch.grouping && patch.grouping !== preferences.grouping
          ? contactCacheFields('grouping', patch.grouping)
          : [];
    if (enabled && shouldOfferContactRefresh(snapshot.data?.rows ?? EMPTY_ROWS, fields, entities))
      setRefreshRequest({ fields, scope: storageKey });
    const value = {
      ...preferences,
      ...patch,
      ...(patch.sort ? { descending: defaultDescending(patch.sort) } : {}),
    };
    setSaved({ key: storageKey, value });
    if (enabled)
      try {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        /* 偏好不影响使用。 */
      }
  };
  const latest = useRef({ key: storageKey, rows: snapshot.data?.rows ?? EMPTY_ROWS });
  if (!freeze || latest.current.key !== storageKey)
    latest.current = { key: storageKey, rows: snapshot.data?.rows ?? EMPTY_ROWS };
  const regions = trpc.account.qqWrite.profileRegions.useQuery(undefined, {
    enabled: enabled && preferences.grouping === 'location',
    staleTime: Infinity,
  });
  const groupDetails = trpc.account.listAllGroups.useQuery(
    { limit: 2000 },
    { enabled: enabled && kind === 'groups' },
  );
  const rawGroupNames = useMemo(
    () => new Map((groupDetails.data ?? []).map((group) => [group.groupCode, group.groupName])),
    [groupDetails.data],
  );
  const needsOnline =
    contactCacheFields('sort', preferences.sort).length > 0 ||
    contactCacheFields('grouping', preferences.grouping).length > 0;
  return {
    preferences,
    change,
    rows: latest.current.rows,
    groupingOptions,
    sortOptions,
    regions: regions.data?.regions ?? EMPTY_REGIONS,
    scopeKey: storageKey,
    rawGroupNames,
    error: snapshot.error?.message,
    progress: snapshot.data?.progress,
    needsOnline,
    refreshRequest: refreshRequest?.scope === storageKey ? refreshRequest : null,
    closeRefresh: () => setRefreshRequest(null),
  };
}

export function useFrozenDirectory<T>(value: T, freeze: boolean, key: string): T {
  const ref = useRef({ key, value });
  if (!freeze || ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}
