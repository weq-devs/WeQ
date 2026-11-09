import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNumberLookup, isLookupNumber } from '../src/renderer/src/hooks/useNumberLookup';
import { NumberLookupResults } from '../src/renderer/src/components/search/NumberLookupResults';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { TitleBarSearch } from '../src/renderer/src/components/TitleBarSearch';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: {
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-a' },
    available: true,
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { qqWrite: { exactProfile: { query: mocks.query } } } },
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => mocks.session,
}));

const profile = (kind: 'user' | 'group', name = '合成资料') => ({
  kind,
  name,
  id: '10002',
  level: kind === 'user' ? 42 : null,
  category: kind === 'group' ? '合成分类' : null,
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  mocks.session = {
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-a' },
    available: true,
  };
  mocks.query
    .mockReset()
    .mockImplementation(({ kind }: { kind: 'user' | 'group' }) => Promise.resolve(profile(kind)));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const tick = (ms = 200) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const render = (keyword = '10002') => act(() => root.render(h(NumberLookupResults, { keyword })));

describe('号码查询', () => {
  it.each(['', 'abc', '0', '010002', '-1', '4294967296', '12345678901'])(
    '无效号码不请求：%s',
    async (keyword) => {
      expect(isLookupNumber(keyword)).toBe(false);
      function Harness() {
        useNumberLookup(keyword);
        return null;
      }
      act(() => root.render(h(Harness)));
      await tick();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
  it('沿用接口的有效范围并去除首尾空白', () => {
    expect(isLookupNumber(' 10002 ')).toBe(true);
    expect(isLookupNumber('1')).toBe(true);
    expect(isLookupNumber('4294967295')).toBe(true);
  });
  it('200ms 防抖后同时查询两类资料并直接显示', async () => {
    render(' 10002 ');
    await tick(199);
    expect(mocks.query).not.toHaveBeenCalled();
    render('10003');
    await tick(199);
    expect(mocks.query).not.toHaveBeenCalled();
    await tick(1);
    expect(mocks.query.mock.calls.map(([input]) => [input.kind, input.target])).toEqual([
      ['user', '10003'],
      ['group', '10003'],
    ]);
    expect(host.textContent).toContain('QQ 等级：42');
    expect(host.textContent).toContain('群分类：合成分类');
    const output = process.env.WEQ_ENTRY_LAYOUT_DIR;
    if (output) {
      mkdirSync(output, { recursive: true });
      const styles = ['index.css', 'search-scope.css']
        .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
        .join('\n');
      writeFileSync(
        resolve(output, 'number-results.html'),
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>body{margin:0;font-family:system-ui;background:var(--background);color:var(--foreground)}main{width:min(720px,calc(100vw - 16px));margin:8px;background:var(--weq-bg-surface)}</style><body><main>${host.innerHTML}</main></body></html>`,
      );
    }
  });
  it('一路失败不遮住另一路，重试只请求失败一路', async () => {
    mocks.query.mockImplementation(({ kind }: { kind: 'user' | 'group' }) =>
      kind === 'user' ? Promise.reject(new Error('合成查询失败')) : Promise.resolve(profile(kind)),
    );
    render();
    await tick();
    expect(host.textContent).toContain('合成查询失败');
    expect(host.textContent).toContain('群分类：合成分类');
    mocks.query.mockImplementation(({ kind }: { kind: 'user' | 'group' }) =>
      Promise.resolve(profile(kind)),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="重试用户查询"]')!.click());
    await tick();
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls[2]![0].kind).toBe('user');
    expect(host.textContent).not.toContain('合成查询失败');
    expect(host.textContent).toContain('QQ 等级：42');
  });
  it('在线能力未就绪不请求，恢复后重新查询且不保留旧结果', async () => {
    render();
    await tick();
    mocks.session.available = false;
    render();
    expect(host.textContent).toContain('QQ 在线能力未就绪');
    await tick(500);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    mocks.session.available = true;
    render();
    expect(host.textContent).not.toContain('合成资料');
    await tick();
    expect(mocks.query).toHaveBeenCalledTimes(4);
  });
  it.each(['keyword', 'account', 'source'] as const)(
    '隔离关键词、账号及同号数据源切换的迟到响应：%s',
    async (change) => {
      const pending: Array<(value: ReturnType<typeof profile>) => void> = [];
      mocks.query.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      render();
      await tick();
      if (change === 'account')
        mocks.session.binding = {
          expectedAccountUin: '10004',
          expectedAccountConfigId: 'synthetic-b',
        };
      if (change === 'source')
        mocks.session.binding = {
          expectedAccountUin: '10001',
          expectedAccountConfigId: 'synthetic-b',
        };
      render(change === 'keyword' ? '10003' : '10002');
      await act(async () => {
        pending[0]!(profile('user', '旧用户'));
        pending[1]!(profile('group', '旧群'));
      });
      expect(host.textContent).not.toContain('旧用户');
      expect(host.textContent).not.toContain('旧群');
      await tick();
      await act(async () => {
        pending[2]!(profile('user', '新用户'));
        pending[3]!(profile('group', '新群'));
      });
      expect(host.textContent).toContain('新用户');
      expect(host.textContent).toContain('新群');
    },
  );
  it('关闭搜索面板及取消范围停止待发查询，已发送的迟到结果不再显示', async () => {
    const pending: Array<(value: ReturnType<typeof profile>) => void> = [];
    mocks.query.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const panel = (enabled: boolean, keyword = '10002') =>
      h(SearchDropdown, {
        keyword,
        categories: [],
        onCategoriesChange: vi.fn(),
        quick: null,
        quickLoading: false,
        slow: null,
        slowLoading: false,
        onSelect: vi.fn(),
        onMore: vi.fn(),
        numberLookupEnabled: enabled,
        onNumberLookupEnabledChange: vi.fn(),
      });
    const search = (enabled: boolean, keyword = '10002') =>
      h(TitleBarSearch, {
        query: keyword,
        onQueryChange: vi.fn(),
        results: panel(enabled, keyword),
      });
    act(() => root.render(search(true)));
    await tick();
    expect(mocks.query).not.toHaveBeenCalled();
    const toggle = () =>
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="全局搜索"]')!.click());
    toggle();
    await tick(100);
    toggle();
    await tick();
    expect(mocks.query).not.toHaveBeenCalled();
    toggle();
    await tick();
    expect(mocks.query).toHaveBeenCalledTimes(2);
    act(() => root.render(search(false)));
    await act(async () => {
      pending[0]!(profile('user', '旧资料'));
      pending[1]!(profile('group', '旧资料'));
    });
    expect(document.body.textContent).not.toContain('旧资料');
    act(() => root.render(search(true, '文字')));
    await tick();
    expect(document.querySelector('[aria-label="QQ号/群号"]')).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
