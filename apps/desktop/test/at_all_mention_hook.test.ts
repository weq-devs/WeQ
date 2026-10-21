import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAtAllMention } from '../src/renderer/src/hooks/useAtAllMention';

const fixture = vi.hoisted(() => ({
  config: { data: { uin: '10001', configId: 'source-a' }, isFetching: false },
  access: {
    data: {
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
    },
    isFetching: false,
  },
  requests: [] as {
    input: { expectedAccountConfigId: string; groupId: number };
    enabled: boolean;
  }[],
}));
vi.mock('../src/renderer/src/state/view', () => ({ useViewState: () => '10001' }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => fixture.config },
      getGroupAlbumAccessState: { useQuery: () => fixture.access },
      qqActions: {
        atAllMention: {
          useQuery: (
            input: { expectedAccountConfigId: string; groupId: number },
            options: { enabled: boolean },
          ) => {
            fixture.requests.push({ input, enabled: options.enabled });
            return {
              isFetching: false,
              data: {
                role: 'admin',
                canManage: true,
                quota: { canAtAll: true, remainCountForUin: 2, remainCountForGroup: 4 },
              },
            };
          },
        },
      },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  fixture.requests.length = 0;
  fixture.config.isFetching = false;
  fixture.access.isFetching = false;
  fixture.config.data.configId = 'source-a';
});

describe('全体额度查询的激活边界', () => {
  it('共享查询在后台刷新时，不反复切换额度查询 enabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.createElement('div'));
    function Probe({ active = true }: { active?: boolean }) {
      useAtAllMention(active, 123);
      return null;
    }
    try {
      await act(async () => root.render(createElement(Probe)));
      fixture.config.isFetching = true;
      fixture.access.isFetching = true;
      await act(async () => root.render(createElement(Probe)));
      fixture.config.isFetching = false;
      fixture.access.isFetching = false;
      await act(async () => root.render(createElement(Probe)));
      expect(fixture.requests.map((request) => request.enabled)).toEqual([true, true, true]);
      await act(async () => root.render(createElement(Probe, { active: false })));
      expect(fixture.requests.at(-1)?.enabled).toBe(false);
      fixture.config.data.configId = 'source-b';
      await act(async () => root.render(createElement(Probe)));
      expect(fixture.requests.at(-1)?.input).toMatchObject({
        expectedAccountConfigId: 'source-b',
        groupId: 123,
      });
    } finally {
      act(() => root.unmount());
    }
  });
});
