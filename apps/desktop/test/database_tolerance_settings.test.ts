import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { salvageLevelsAscending } from '@weq/service/db-tolerance-copy';
import { DatabaseToleranceSection } from '../src/renderer/src/components/settings/DatabaseToleranceSection';

const fixture = vi.hoisted(() => ({
  level: 0,
  available: true,
  error: null as Error | null,
  save: vi.fn(),
  toast: vi.fn(),
  retry: vi.fn(async () => ({})),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({
  useToast: (select: (state: { push: typeof fixture.toast }) => unknown) =>
    select({ push: fixture.toast }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => ({
            data: path.endsWith('getDbTolerance')
              ? fixture.available
                ? { level: fixture.level, grantedAt: null, summary: { total: 3 }, entries: [] }
                : undefined
              : [],
            error: path.endsWith('getDbTolerance') ? fixture.error : null,
            isLoading: false,
            isFetching: false,
            refetch: fixture.retry,
          });
        if (key === 'useMutation') return () => ({ mutateAsync: fixture.save, isPending: false });
        if (key === 'invalidate') return async () => {};
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => {
  fixture.level = 0;
  fixture.available = true;
  fixture.error = null;
  fixture.save.mockReset();
  fixture.toast.mockReset();
  fixture.retry.mockClear();
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.save.mockImplementation(async ({ level }: { level: number }) => {
    fixture.level = level;
    return { closedSalvage: 0 };
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        createElement(DatabaseToleranceSection, { page: 'management', onOpenRecords: vi.fn() }),
      ),
    );
  render();
  const select = host.querySelector<HTMLSelectElement>('[aria-label="数据库容错级别"]')!;
  return {
    host,
    select,
    render,
    choose: async (value: string) =>
      act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('容错级别使用单一下拉选择，计数与记录标题同一行，不保留重复说明或损坏提醒标题', () => {
  const f = mount();
  try {
    expect([...f.select.options].map((option) => option.textContent)).toEqual(
      salvageLevelsAscending().map((copy) => copy.title),
    );
    expect(f.host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(f.host.textContent).not.toContain('默认严格模式：');
    expect([...f.host.querySelectorAll('h4')].some((node) => node.textContent === '损坏提醒')).toBe(
      false,
    );
    const records = f.host.querySelector('[data-setting-id="tolerance-records"]')!;
    expect(records.querySelector('h4')?.textContent).toBe('当前账号容错记录');
    expect(records.querySelector('[role="status"]')?.textContent).toBe('3 次 · 0 表隔离');
    expect(records.querySelector('h4')?.parentElement).toBe(
      records.querySelector('[role="status"]')?.parentElement,
    );
  } finally {
    f.close();
  }
});

it('无损级别直接保存，恢复严格仍可用', async () => {
  const f = mount();
  try {
    await f.choose('1');
    expect(fixture.save).toHaveBeenLastCalledWith({ level: 1, source: 'settings' });
    f.render();
    await f.choose('0');
    expect(fixture.save).toHaveBeenLastCalledWith({ level: 0, source: 'settings' });
  } finally {
    f.close();
  }
});

it.each([2, 3])('可能少读数据的级别 %s 仍须原位确认，取消不保存', async (level) => {
  const f = mount();
  try {
    await f.choose(String(level));
    expect(fixture.save).not.toHaveBeenCalled();
    expect(f.host.querySelector('.weq-set-confirm')?.textContent).toContain(
      salvageLevelsAscending()[level]!.confirm,
    );
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '取消')!
        .click(),
    );
    expect(f.select.value).toBe('0');
    await f.choose(String(level));
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes(`确认启用级别 ${level}`))!
        .click(),
    );
    expect(fixture.save).toHaveBeenCalledOnce();
    expect(fixture.save).toHaveBeenCalledWith({ level, source: 'settings' });
  } finally {
    f.close();
  }
});

it('读取失败不冒充严格级别，并保留重试', async () => {
  fixture.available = false;
  fixture.error = new Error('合成读取失败');
  const f = mount();
  try {
    expect(f.select.disabled).toBe(true);
    expect(f.select.value).toBe('');
    await f.choose('1');
    expect(fixture.save).not.toHaveBeenCalled();
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="重新读取容错级别"]')!.click(),
    );
    expect(fixture.retry).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});
