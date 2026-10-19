import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BuddyAnalyticsDialog } from '../src/renderer/src/components/BuddyAnalyticsDialog';
import { formatDate } from '../src/renderer/src/components/analyticsCharts';
import { GroupJoinBatches } from '../src/renderer/src/components/GroupJoinBatches';

const fixture = vi.hoisted(() => ({ save: vi.fn(), query: vi.fn(), available: true }));
vi.mock('../src/renderer/src/components/analyticsShot', () => ({
  exportAnalyticsCard: fixture.save,
  canExportAnalyticsCard: () => fixture.available,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getBuddyAnalytics: { query: fixture.query } } },
}));
afterEach(() => {
  fixture.available = true;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('没有图片导出桥接的环境明确禁用该操作，不把调用入口当作可用能力', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.available = false;
  fixture.query.mockResolvedValue(null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(BuddyAnalyticsDialog, {
          peerUid: 'u_peer',
          peerName: '合成好友',
          embedded: true,
          onClose: vi.fn(),
        }),
      ),
    );
    expect(
      host.querySelector<HTMLButtonElement>('[title="当前环境不支持保存长图"]')!.disabled,
    ).toBe(true);
    expect(fixture.save).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('嵌入结果保留真实图片导出与时间口径，已有快照不重复扫描', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.save.mockResolvedValue({ saved: false, canceled: true });
  const data = {
    peer: { uid: 'u_peer', uin: '' },
    self: { uin: '' },
    statistics: {
      totalMessages: 0,
      selfMessages: 0,
      peerMessages: 0,
      firstMessageTime: null,
      lastMessageTime: null,
      activeDays: 0,
    },
    messageTypes: { text: 0, image: 0, voice: 0, video: 0, emoji: 0, other: 0 },
    hourlySelf: {},
    hourlyPeer: {},
    daily: [],
    initiation: { self: 0, peer: 0, total: 0 },
    reply: { self: null, peer: null },
    streak: { longest: 0, current: 0 },
    phrasesSelf: [],
    phrasesPeer: [],
    emojisSelf: [],
    emojisPeer: [],
    wordCloud: [],
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    close = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(BuddyAnalyticsDialog, {
          peerUid: 'u_peer',
          peerName: '合成好友',
          initialData: data,
          embedded: true,
          periodLabel: '2026-10-01 至 2026-10-18 · 北京时间',
          onClose: close,
        }),
      ),
    );
    expect(host.querySelector('.weq-analysis-period')?.textContent).toContain('北京时间');
    expect(fixture.query).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[title="保存为图片"]')!.click());
    expect(fixture.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'buddy',
        peerUid: 'u_peer',
        data,
        periodLabel: '2026-10-01 至 2026-10-18 · 北京时间',
      }),
    );
    act(() => host.querySelector<HTMLButtonElement>('[title="关闭"]')!.click());
    expect(close).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('分析日期显示固定北京时间，异常时间不输出假日期', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  expect(formatDate(Date.parse('2026-10-18T00:00:00+08:00') / 1000)).toBe('2026/10/18');
  expect(formatDate(NaN)).toBe('-');
  expect(formatDate(Number.MAX_SAFE_INTEGER)).toBe('-');
});

it('入群批次跨北京时间年界显示两侧正确年份和时刻', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const start = Date.parse('2025-12-31T23:59:00+08:00') / 1000;
  const end = start + 120;
  const members = Array.from({ length: 3 }, (_, index) => ({
    uid: `u_${index}`,
    uin: '',
    displayName: `合成成员 ${index}`,
    joinTime: start + index * 60,
    lastSpeakTime: 0,
    memberLevel: 1,
    messageCount: 1,
  }));
  const report = {
    memberTotal: 3,
    datedMemberCount: 3,
    unknownJoinCount: 0,
    threshold: 3,
    windowSeconds: 10800,
    batchMemberCount: 3,
    groupMessageTotal: 3,
    firstJoinTime: start,
    lastJoinTime: end,
    batches: [
      {
        index: 1,
        startTime: start,
        endTime: end,
        spanSeconds: 120,
        members,
        messageCount: 3,
        topSpeaker: members[0],
      },
    ],
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(GroupJoinBatches, { report })));
    expect(host.textContent).toContain('2025/12/31 23:59');
    expect(host.textContent).toContain('2026/01/01 00:01');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
