import { useEffect } from 'react';
import type { GroupProfileExtras } from '@weq/protocol';
const profile: GroupProfileExtras = {
  grade: 5,
  activeMemberCount: 467,
  freezeState: 0,
  freezeReason: 0,
  portraitSequence: 2,
  portrait: { count: 1, defaultId: 2, pictures: [] },
};
type Qa = { mode: string; refreshes: number; setMode: (mode: string) => void };
const qa = () => (window as unknown as { groupProfileQa: Qa }).groupProfileQa;
const binding = { expectedAccountUin: '99999', expectedAccountConfigId: 'fixture' };
export const trpc = {
  useUtils: () => ({ account: { contactMetrics: { snapshot: { invalidate: async () => {} } } } }),
  account: {
    getAccountConfig: { useQuery: () => ({ data: { uin: '99999', configId: 'fixture' } }) },
    getGroupAlbumAccessState: {
      useQuery: () => ({
        data: {
          qqOnline: !qa().mode.startsWith('offline'),
          attachEnabled: true,
          hasA2: true,
          hasD2: true,
          hasD2Key: true,
          hasGuid: true,
          ssoReady: true,
          source: binding,
        },
      }),
    },
    getGroupExtendedProfile: {
      useQuery: (input: { force: boolean }) => {
        useEffect(() => {
          if (input.force) {
            qa().refreshes++;
            qa().setMode('ready');
          }
        }, [input.force]);
        const state = qa();
        const value =
          state.mode === 'zero'
            ? { ...profile, grade: 0, activeMemberCount: 0, portraitSequence: null, portrait: null }
            : state.mode === 'offline-empty'
              ? null
              : profile;
        return {
          data: {
            groupId: state.mode === 'wrong-target' ? 124 : 123,
            profile: value,
            updatedAt: 1794380000000,
            source: state.mode === 'offline' || state.mode === 'error' ? 'cache' : 'online',
            error:
              state.mode === 'error' ? '失败' : state.mode === 'cache-save' ? '缓存保存失败' : null,
          },
          isFetching: state.mode === 'loading',
          error: null,
          refetch: async () => {
            state.refreshes++;
            state.setMode('ready');
          },
        };
      },
    },
    contactMetrics: {
      snapshot: { useQuery: () => ({ data: { rows: {} } }) },
      changed: { useSubscription: () => {} },
    },
  },
};
