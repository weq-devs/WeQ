import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountBasicsSection } from '../src/renderer/src/components/settings/AccountBasicsSection';

const fixture = vi.hoisted(() => ({
  settings: {
    reportReadEnabled: false,
    manualReadReportEnabled: false,
    realtimeEnabled: true,
    autoAttachQq: true,
    restrictedModeBannerEnabled: true,
    externalChatpic: { dir: '', enabled: false },
  },
  state: 'disabled',
  readReportQuery: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
  mutations: [] as string[],
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
            ? () => {
                fixture.mutations.push(path.join('.'));
                return { mutateAsync: fixture.mutate, isPending: false };
              }
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy() };
});
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (
    select: (value: {
      showError: typeof fixture.error;
      confirm: typeof fixture.confirm;
    }) => unknown,
  ) => select({ showError: fixture.error, confirm: fixture.confirm }),
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  fixture.settings = {
    reportReadEnabled: false,
    manualReadReportEnabled: false,
    realtimeEnabled: true,
    autoAttachQq: true,
    restrictedModeBannerEnabled: true,
    externalChatpic: { dir: '', enabled: false },
  };
  fixture.state = 'disabled';
  fixture.mutations = [];
  fixture.confirm.mockResolvedValue(true);
  fixture.mutate.mockImplementation(async ({ enabled }: { enabled: boolean }) => {
    fixture.settings = {
      ...fixture.settings,
      reportReadEnabled: enabled,
      manualReadReportEnabled: enabled,
    };
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount(page: 'read' | 'account' = 'read') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(createElement(AccountBasicsSection, { page })));
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
  it('受限横幅偏好可独立保存，保存失败恢复原开关', async () => {
    fixture.mutate.mockImplementation(async ({ enabled }: { enabled: boolean }) => {
      fixture.settings = { ...fixture.settings, restrictedModeBannerEnabled: enabled };
    });
    const f = mount('account');
    const toggle = () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="进入受限模式时横幅提醒"]')!;
    try {
      expect(toggle().getAttribute('aria-checked')).toBe('true');
      await act(async () => toggle().click());
      expect(toggle().getAttribute('aria-checked')).toBe('false');
      expect(fixture.mutations).toContain('bootstrap.setRestrictedModeBannerEnabled');
      fixture.mutate.mockRejectedValueOnce(new Error('合成保存失败'));
      await act(async () => toggle().click());
      expect(toggle().getAttribute('aria-checked')).toBe('false');
      expect(fixture.error).toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('默认关闭，实际点击保存，重新打开恢复偏好', async () => {
    let f = mount();
    try {
      expect(f.toggle().getAttribute('aria-checked')).toBe('false');
      await act(async () => {
        f.toggle().click();
      });
      expect(fixture.mutate).toHaveBeenCalledWith({ enabled: true });
      expect(fixture.confirm).toHaveBeenCalledOnce();
      expect(fixture.mutations).toContain('bootstrap.setReadSyncEnabled');
      expect(fixture.mutations).not.toContain('bootstrap.setReportReadEnabled');
      expect(fixture.mutations).not.toContain('bootstrap.setManualReadReportEnabled');
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
      expect(card?.textContent).toContain('向 QQ 上报在 WeQ 阅读和手动标记的位置');
      expect(fixture.readReportQuery).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each([
    [false, false],
    [true, true],
    [true, false],
    [false, true],
  ])('旧自动/手动组合 %s/%s 只展示，不自动改写', (automatic, manual) => {
    fixture.settings = {
      ...fixture.settings,
      reportReadEnabled: automatic,
      manualReadReportEnabled: manual,
    };
    const f = mount();
    try {
      expect(f.toggle().getAttribute('aria-checked')).toBe(String(automatic || manual));
      expect(f.host.textContent?.includes('沿用原设置')).toBe(automatic !== manual);
      expect(f.host.querySelectorAll('[aria-label="手动标记时上报已读位置"]')).toHaveLength(0);
      expect(fixture.mutate).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('取消开启不写入，重复点击只确认和提交一次', async () => {
    const f = mount();
    try {
      fixture.confirm.mockResolvedValueOnce(false);
      await act(async () => f.toggle().click());
      expect(fixture.mutate).not.toHaveBeenCalled();
      fixture.confirm.mockResolvedValueOnce(true);
      await act(async () => {
        f.toggle().click();
        f.toggle().click();
      });
      expect(fixture.mutate).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('混合状态关闭一次提交两个字段；失败重新读取实际状态', async () => {
    fixture.settings = { ...fixture.settings, manualReadReportEnabled: true };
    const f = mount();
    try {
      fixture.mutate.mockRejectedValueOnce(new Error('合成写入失败'));
      fixture.refetch.mockResolvedValueOnce({
        data: { ...fixture.settings, reportReadEnabled: true },
      });
      await act(async () => f.toggle().click());
      expect(fixture.refetch).toHaveBeenCalledOnce();
      expect(fixture.confirm).not.toHaveBeenCalled();
      expect(f.toggle().getAttribute('aria-checked')).toBe('true');
      expect(fixture.error).toHaveBeenCalled();
      await act(async () => f.toggle().click());
      expect(fixture.mutate).toHaveBeenLastCalledWith({ enabled: false });
    } finally {
      f.close();
    }
  });
});
