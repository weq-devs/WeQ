import { useEffect, useMemo, useRef, useState } from 'react';
import { PREFERENCES_CHANGED, changePreference, preferenceValue } from '../lib/clientPreferences';
import type { ContactMetric, ContactMetricRows } from '@weq/service';
import { accountOrderDefaults, isDirectoryPreference } from '@weq/service/client-preferences';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useQQReadActivity } from './useQQAutoRefresh';
import { contactCacheFields, shouldOfferContactRefresh } from '../lib/contactCachePolicy';
import { queryInputBatches } from '../lib/queryInputBatches';
import { IS_WEB } from '../lib/target.shared';
import {
  defaultDescending,
  FRIEND_GROUPS,
  FRIEND_SORTS,
  GROUP_GROUPS,
  GROUP_SORTS,
  withLocalGroupJoinTimes,
  type DirectoryPreferences,
  type RegionNode,
  type DirectoryRows,
} from '../lib/contactListOrder';
const EMPTY_ROWS: ContactMetricRows = {};
const EMPTY_REGIONS: RegionNode[] = [];
const emptySeeds = () => EMPTY_ROWS;

export function useContactDirectoryOrder(
  kind: 'friends' | 'groups',
  freeze: boolean,
  entities: readonly (readonly string[])[],
  seedTimes: () => DirectoryRows = emptySeeds,
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
      if (event.profiles) {
        utils.account.contactMetrics.cachedProfiles.setData(binding, []);
        void utils.account.contactMetrics.cachedProfiles.invalidate(binding);
        return;
      }
      void utils.account.contactMetrics.snapshot.invalidate(binding);
      if (event.base) {
        void utils.account.contactMetrics.localJoins.invalidate(binding);
        void utils.account.listProfiles.invalidate();
        void utils.account.listBuddies.invalidate();
        void utils.account.listCategories.invalidate();
        void utils.account.listAllGroups.invalidate();
      }
    },
  });
  const groupingOptions = kind === 'friends' ? FRIEND_GROUPS : GROUP_GROUPS;
  const sortOptions = kind === 'friends' ? FRIEND_SORTS : GROUP_SORTS;
  const defaults = useMemo<DirectoryPreferences>(() => ({ ...accountOrderDefaults[kind] }), [kind]);
  const storageKey = `weq.contacts.order.${configId ?? ''}.${uin ?? ''}.${kind}`;
  const [saved, setSaved] = useState<{ key: string; value: DirectoryPreferences }>();
  const [sharedTick, setSharedTick] = useState(0);
  useEffect(() => {
    const update = () => {
      setSaved(undefined);
      setSharedTick((value) => value + 1);
    };
    window.addEventListener(PREFERENCES_CHANGED, update);
    return () => window.removeEventListener(PREFERENCES_CHANGED, update);
  }, []);
  const [refreshRequest, setRefreshRequest] = useState<{
    fields: ContactMetric[];
    scope: string;
  } | null>(null);
  const storedPreferences = useMemo(() => {
    if (!enabled) return defaults;
    try {
      const parsed = preferenceValue('contactOrder')[kind];
      if (isDirectoryPreference(kind, parsed))
        return { grouping: parsed.grouping, sort: parsed.sort, descending: parsed.descending };
    } catch {
      /* 缺少偏好时使用默认值。 */
    }
    return defaults;
  }, [storageKey, enabled, defaults, groupingOptions, sortOptions, sharedTick, kind]);
  const preferences = saved?.key === storageKey ? saved.value : storedPreferences;
  const activity = useQQReadActivity(enabled && !freeze, { onlineOnly: false });
  const needsTimes = ['lastMessageAt', 'lastSpokeAt'].includes(preferences.sort);
  const needsMaxSeq = kind === 'groups' && preferences.sort === 'maxSeq';
  const seeds = useMemo<DirectoryRows>(
    () => (needsTimes ? seedTimes() : EMPTY_ROWS),
    [needsTimes, seedTimes],
  );
  const times = trpc.account.contactMetrics.localTimes.useQuery(binding, {
    enabled: activity.enabled && kind === 'friends' && needsTimes,
    keepPreviousData: false,
    refetchInterval: (data) => (data?.done ? 5000 : 250),
  });
  const groupTimeInputs = useMemo(() => {
    if (!enabled || kind !== 'groups' || !needsTimes) return [];
    const codes = entities.flatMap(([key]) => /^group:([1-9]\d{0,14})$/.exec(key ?? '')?.[1] ?? []);
    return queryInputBatches(
      'account.contactMetrics.localGroupTimes',
      [...new Set(codes)].sort(),
      (groupCodes) => ({ ...binding, groupCodes }),
      IS_WEB,
      256,
    );
  }, [enabled, kind, needsTimes, entities, binding]);
  const groupQueries = trpc.useQueries((rpc) =>
    groupTimeInputs.map((input) =>
      rpc.account.contactMetrics.localGroupTimes(input, {
        enabled: activity.enabled,
        refetchInterval: (data) => (data?.done ? 5000 : 250),
      }),
    ),
  );
  const previousGroupQueries = useRef(groupQueries);
  if (
    groupQueries.length !== previousGroupQueries.current.length ||
    groupQueries.some((query, index) => {
      const previous = previousGroupQueries.current[index];
      return query.data !== previous?.data || query.error !== previous?.error;
    })
  )
    previousGroupQueries.current = groupQueries;
  const groupTimes = previousGroupQueries.current;
  const maxSeqs = trpc.account.contactMetrics.localGroupMaxSeqs.useQuery(binding, {
    enabled: activity.enabled && needsMaxSeq,
    keepPreviousData: false,
    refetchInterval: 5000,
  });
  const profiles = trpc.account.contactMetrics.cachedProfiles.useQuery(binding, {
    enabled: activity.enabled && kind === 'friends' && preferences.sort === 'affinity',
    keepPreviousData: false,
    refetchInterval: 2000,
  });
  const joins = trpc.account.contactMetrics.localJoins.useQuery(binding, {
    enabled: activity.enabled && kind === 'groups' && preferences.sort === 'joinedAt',
    keepPreviousData: false,
    staleTime: 5000,
  });
  const projectedRows = useMemo<DirectoryRows>(() => {
    if (!needsTimes && !needsMaxSeq && !['affinity', 'joinedAt'].includes(preferences.sort))
      return snapshot.data?.rows ?? EMPTY_ROWS;
    const rows: DirectoryRows = { ...(snapshot.data?.rows ?? EMPTY_ROWS) };
    if (needsTimes)
      for (const [key, seed] of Object.entries(seeds)) rows[key] = { ...rows[key], ...seed };
    if (kind === 'friends' && needsTimes && times.data) {
      const state = times.data.done ? ('ready' as const) : ('stale' as const);
      for (const aliases of entities) {
        const key = aliases.find((alias) => alias.startsWith('friend:u_')) ?? aliases[0];
        if (!key) continue;
        const id = key.slice(key.indexOf(':') + 1);
        const value = times.data.rows[id];
        const latest = (a: unknown, b: number | null | undefined) =>
          typeof a === 'number' && a > (b ?? 0) ? a : (b ?? undefined);
        rows[key] = {
          ...rows[key],
          lastMessageAt: {
            partial: !times.data.done,
            value: latest(seeds[key]?.lastMessageAt?.value, value?.time),
            state,
            attemptedAt: 0,
          },
        };
      }
    }
    for (const [index, result] of groupTimes.entries()) {
      if (!result.data && !result.error) continue;
      const failed = new Set(result.data?.failed);
      for (const code of groupTimeInputs[index]!.groupCodes) {
        const key = `group:${code}`;
        const local = result.data?.rows[code];
        const hasError = result.error || failed.has(code);
        const cell = (sort: 'lastMessageAt' | 'lastSpokeAt', time: number | null | undefined) => {
          const seed = seeds[key]?.[sort]?.value;
          return {
            value: typeof seed === 'number' && seed > (time ?? 0) ? seed : (time ?? undefined),
            state: hasError
              ? ('failed' as const)
              : time === undefined
                ? ('stale' as const)
                : ('ready' as const),
            partial: time === undefined && !hasError,
            attemptedAt: 0,
          };
        };
        rows[key] = {
          ...rows[key],
          lastMessageAt: cell('lastMessageAt', local?.time),
          lastSpokeAt: cell('lastSpokeAt', local?.mine),
        };
      }
    }
    if (needsMaxSeq && (maxSeqs.data || maxSeqs.error)) {
      for (const [key] of entities) {
        if (!key?.startsWith('group:')) continue;
        rows[key] = {
          ...rows[key],
          maxSeq: {
            value: maxSeqs.data?.[key.slice('group:'.length)],
            state: maxSeqs.error ? 'failed' : 'ready',
            error: maxSeqs.error?.message,
            attemptedAt: 0,
          },
        };
      }
    }
    if (kind === 'friends' && preferences.sort === 'affinity')
      for (const profile of profiles.data ?? [])
        rows[`friend:${profile.uid}`] = {
          ...rows[`friend:${profile.uid}`],
          affinity: {
            value: profile.affinity,
            state: 'ready',
            attemptedAt: profile.computedAt,
            updatedAt: profile.computedAt,
          },
        };
    return preferences.sort === 'joinedAt' ? withLocalGroupJoinTimes(rows, joins.data ?? {}) : rows;
  }, [
    snapshot.data?.rows,
    needsTimes,
    times.data,
    groupTimeInputs,
    groupTimes,
    needsMaxSeq,
    maxSeqs.data,
    maxSeqs.error,
    profiles.data,
    joins.data,
    kind,
    preferences.sort,
    entities,
    seeds,
  ]);
  const change = (patch: Partial<DirectoryPreferences>) => {
    const fields =
      patch.sort && patch.sort !== preferences.sort
        ? contactCacheFields('sort', patch.sort)
        : patch.grouping && patch.grouping !== preferences.grouping
          ? contactCacheFields('grouping', patch.grouping)
          : [];
    const active =
      snapshot.data?.progress.status === 'running' || snapshot.data?.progress.status === 'paused';
    if (
      enabled &&
      !active &&
      shouldOfferContactRefresh(snapshot.data?.rows ?? EMPTY_ROWS, fields, entities)
    )
      setRefreshRequest({ fields, scope: storageKey });
    const value = {
      ...preferences,
      ...patch,
      ...(patch.sort ? { descending: defaultDescending(patch.sort) } : {}),
    };
    setSaved({ key: storageKey, value });
    if (enabled) void changePreference('contactOrder', { [kind]: value });
  };
  const latest = useRef({ key: storageKey, rows: projectedRows });
  if (!freeze || latest.current.key !== storageKey)
    latest.current = { key: storageKey, rows: projectedRows };
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
    error:
      snapshot.error?.message ??
      (needsTimes
        ? times.error?.message
        : needsMaxSeq
          ? maxSeqs.error?.message
          : preferences.sort === 'affinity'
            ? profiles.error?.message
            : preferences.sort === 'joinedAt'
              ? joins.error?.message
              : undefined),
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
