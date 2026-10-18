import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnalysisTool } from '../src/renderer/src/views/analysis/AnalysisTool';
import { analysisDateRange } from '../src/renderer/src/views/analysis/model';
import { useViewState } from '../src/renderer/src/state/view';

const fixture = vi.hoisted(() => ({
  config: vi.fn(),
  friends: [] as { uid: string; uin: string; name: string; categoryId: number }[],
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const result = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
  return {
    client: { account: { getAccountConfig: { query: fixture.config } } },
    trpc: {
      account: {
        annualReport: { getAvailableYears: { useQuery: () => result([2025, 0]) } },
        exportGroupDirectory: {
          useQuery: () =>
            result([
              { groupCode: '777', groupName: '合成群 A' },
              { groupCode: '888', groupName: '合成群 B' },
            ]),
        },
        contactsExportPreview: {
          useQuery: (input: { scope: string; groupCode?: string }) =>
            result(
              input.scope === 'friends'
                ? fixture.friends
                : [
                    {
                      uid: `u_${input.groupCode}`,
                      uin: '10003',
                      name: `合成成员 ${input.groupCode}`,
                      categoryId: 0,
                    },
                  ],
            ),
        },
      },
    },
  };
});
let restoreAccount: string | null;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  restoreAccount = useViewState.getState().openedUin;
  useViewState.setState({ openedUin: '10001' });
  fixture.config.mockResolvedValue({ uin: '10001', configId: 'synthetic' });
  fixture.friends = Array.from({ length: 2501 }, (_, i) => ({
    uid: `u_friend_${i}`,
    uin: `${20000 + i}`,
    name: `合成好友 ${i}`,
    categoryId: 0,
  }));
});
afterEach(() => {
  useViewState.setState({ openedUin: restoreAccount });
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function change(node: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype =
      node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    generate = vi.fn();
  act(() => root.render(createElement(AnalysisTool, { onGenerate: generate })));
  return {
    host,
    generate,
    select: (label: string, value: string) =>
      change(host.querySelector(`[aria-label="${label}"]`)!, value),
    button: (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        node.textContent?.includes(text),
      )!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('年度与好友都创建真实配置，完整目录可检索末尾且 DOM 有界', async () => {
  vi.stubGlobal('crypto', {});
  const f = mount();
  try {
    f.select('报告年份', '2025');
    await act(async () => f.button('生成报告').click());
    expect(f.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'annual',
        year: 2025,
        scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' },
      }),
    );
    f.select('报告类型', 'buddy');
    expect(f.host.querySelectorAll('.weq-analysis-choice').length).toBeLessThan(30);
    f.select('搜索分析对象', '合成好友 2500');
    act(() => f.button('合成好友 2500').click());
    f.select('分析时间范围', 'dates');
    f.select('开始日期', '2026-10-01');
    f.select('结束日期', '2026-10-18');
    await act(async () => f.button('生成报告').click());
    const request = f.generate.mock.calls.at(-1)![0];
    expect(request.id).toMatch(/^analysis-report-/);
    expect(request.id).not.toBe(f.generate.mock.calls[0]![0].id);
    expect(request).toMatchObject({
      kind: 'buddy',
      peerUid: 'u_friend_2500',
      scope: {
        ...analysisDateRange('2026-10-01', '2026-10-18'),
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'synthetic',
      },
    });
    f.select('结束日期', '2026-10-19');
    expect(request.scope.endTime).toBe(Date.parse('2026-10-19T00:00:00+08:00') / 1000 - 1);
  } finally {
    f.close();
  }
});

it('群成员身份按群隔离，换群不沿用旧成员，非法日期不创建报告', async () => {
  const f = mount();
  try {
    f.select('报告类型', 'member');
    act(() => f.button('合成群 A').click());
    act(() => f.button('合成成员 777').click());
    await act(async () => f.button('生成报告').click());
    expect(f.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'member', groupCode: '777', memberUid: 'u_777' }),
    );
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-analysis-group')!.click());
    act(() => f.button('合成群 B').click());
    expect(f.button('生成报告').disabled).toBe(true);
    act(() => f.button('合成成员 888').click());
    f.select('分析时间范围', 'dates');
    f.select('开始日期', '2026-10-18');
    f.select('结束日期', '2026-10-01');
    await act(async () => f.button('生成报告').click());
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('不能晚于');
    expect(f.generate).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});

it('确认身份期间防重复提交，切号销毁草稿并拒绝旧响应', async () => {
  let finish!: (value: unknown) => void;
  fixture.config.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const f = mount();
  try {
    act(() => {
      f.button('生成报告').click();
      f.button('生成报告').click();
    });
    expect(fixture.config).toHaveBeenCalledOnce();
    act(() => useViewState.setState({ openedUin: '10002' }));
    await act(async () => finish({ uin: '10001', configId: 'synthetic' }));
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="报告类型"]')!.value).toBe(
      'annual',
    );
    expect(f.button('生成报告').disabled).toBe(false);
  } finally {
    f.close();
  }
});

it('日期解析拒绝溢出的自然日期，闭区间按北京时间而非默认时区', () => {
  expect(() => analysisDateRange('2026-02-31', '2026-03-01')).toThrow();
  expect(analysisDateRange('2026-10-18', '2026-10-18')).toEqual({
    startTime: 1792252800,
    endTime: 1792339199,
  });
});
