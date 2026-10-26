import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ResourceStat } from '@weq/service';
import { ResourceAnalyticsDialog } from '../src/renderer/src/views/cache/ResourceAnalyticsDialog';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { mediaResource: { analyzeTree: { query } } } },
}));
vi.mock('../src/renderer/src/components/WorkspacePages', () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => children,
}));
it('后续目录还在扫描时，已完成目录立即进入图表，并明确标记累计值', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const stat: ResourceStat = {
    key: 'pic',
    present: true,
    files: 3,
    bytes: 3072,
    byMonth: { '2026-10': { files: 3, bytes: 3072 } },
    ori: { files: 3, bytes: 3072 },
    thumb: { files: 0, bytes: 0 },
    other: { files: 0, bytes: 0 },
  };
  query
    .mockReset()
    .mockResolvedValueOnce(stat)
    .mockImplementationOnce(() => new Promise(() => {}));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(createElement(ResourceAnalyticsDialog, { open: true, onClose() {} })),
    );
    expect(host.textContent).toContain('已统计占用空间');
    expect(host.textContent).toContain('已统计文件数');
    expect(host.querySelector('.weq-ra-progress')?.textContent).toContain('视频');
    const cards = [...host.querySelectorAll('.weq-ra-card')];
    expect(cards.slice(0, 3).every((card) => !card.querySelector('.weq-ra-waiting'))).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
