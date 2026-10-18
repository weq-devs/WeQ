import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';

const fixture = vi.hoisted(() => ({
  settings: {
    reportReadEnabled: false,
    realtimeEnabled: true,
    autoAttachQq: true,
    externalChatpic: { dir: '', enabled: false },
  },
  state: 'disabled',
  readReportQuery: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => {
              if (path.includes('getReadReportStatus')) fixture.readReportQuery();
              return {
                data: path.includes('getSettings')
                  ? fixture.settings
                  : path.includes('getReadReportStatus')
                    ? { state: fixture.state }
                    : path.includes('getAccountConfig')
                      ? { static: false }
                      : undefined,
                isLoading: false,
                refetch: fixture.refetch,
              };
            }
          : key === 'useMutation'
            ? () => ({ mutateAsync: fixture.mutate, isPending: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy() };
});
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (value: { showError: typeof fixture.error }) => unknown) =>
    select({ showError: fixture.error }),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  fixture.settings = {
    reportReadEnabled: false,
    realtimeEnabled: true,
    autoAttachQq: true,
    externalChatpic: { dir: '', enabled: false },
  };
  fixture.state = 'disabled';
  fixture.mutate.mockImplementation(async ({ enabled }: { enabled: boolean }) => {
    fixture.settings = { ...fixture.settings, reportReadEnabled: enabled };
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(createElement(AccountBasicsSection)));
  render();
  return {
    host,
    render,
    toggle: () =>
      host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="同步已读状态到 QQ"]')!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('设置中的已读上报开关', () => {
  it('默认关闭，实际点击保存，重新打开恢复偏好', async () => {
    let f = mount();
    try {
      expect(f.toggle().getAttribute('aria-checked')).toBe('false');
      await act(async () => {
        f.toggle().click();
      });
      expect(fixture.mutate).toHaveBeenCalledWith({ enabled: true });
      expect(f.toggle().getAttribute('aria-checked')).toBe('true');
      f.close();
      f = mount();
      expect(f.toggle().getAttribute('aria-checked')).toBe('true');
      await act(async () => {
        f.toggle().click();
      });
      expect(fixture.mutate).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      f.close();
    }
  });

  it('保存失败回滚开关；完全离线时保留偏好', async () => {
    const f = mount();
    try {
      fixture.mutate.mockRejectedValueOnce(new Error('保存失败'));
      await act(async () => {
        f.toggle().click();
      });
      expect(f.toggle().getAttribute('aria-checked')).toBe('false');
      expect(fixture.error).toHaveBeenCalled();
      fixture.settings = { ...fixture.settings, reportReadEnabled: true, autoAttachQq: false };
      f.render();
      expect(f.toggle().getAttribute('aria-checked')).toBe('true');
    } finally {
      f.close();
    }
  });

  it.each([
    'disabled',
    'unavailable',
    'skipped',
    'pending',
    'acknowledged',
    'unconfirmed',
    'failed',
  ])('开启后不显示 %s 状态提示，也不查询上报状态', (state) => {
    fixture.settings = { ...fixture.settings, reportReadEnabled: true };
    fixture.state = state;
    const f = mount();
    try {
      const card = f.toggle().closest('.weq-set-card');
      expect(card).not.toBeNull();
      expect(card?.querySelector('[role="status"]')).toBeNull();
      expect(card?.textContent).toContain('向 QQ 上报在 WeQ 阅读的位置');
      expect(fixture.readReportQuery).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});
