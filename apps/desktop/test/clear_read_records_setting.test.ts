import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ClearReadRecordsSetting } from '../src/renderer/src/components/settings/ClearReadRecordsSetting';

const fixture = vi.hoisted(() => ({
  config: { uin: '10001', configId: 'source-a' } as { uin: string; configId: string } | undefined,
  clear: vi.fn(),
  confirm: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: fixture.confirm }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: fixture.config }) },
      clearLocalReadRecords: { useMutation: () => ({ mutateAsync: fixture.clear }) },
    },
    useUtils: () => ({ account: { getUnreadInfos: { invalidate: fixture.invalidate } } }),
  },
}));
afterEach(() => {
  fixture.config = { uin: '10001', configId: 'source-a' };
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(createElement(ClearReadRecordsSetting)));
  render();
  return {
    host,
    render,
    button: () => host.querySelector('button')!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('红色清除按钮与用途说明，确认后绑定当前账号并刷新未读', async () => {
  fixture.confirm.mockResolvedValue(true);
  fixture.clear.mockResolvedValue({ cleared: true });
  const f = mount();
  try {
    expect(f.button().classList.contains('weq-set-btn-danger')).toBe(true);
    expect(f.button().dataset.danger).toBe('outline');
    expect(f.host.textContent).toContain('当未读标记出现异常时使用');
    await act(async () => f.button().click());
    expect(fixture.clear).toHaveBeenCalledOnce();
    expect(fixture.confirm).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ danger: 'outline' }),
    );
    expect(fixture.clear).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
    });
    expect(fixture.invalidate).toHaveBeenCalledOnce();
    expect(f.host.querySelector('[role="status"]')?.textContent).toBe('已清除');
    fixture.config = { uin: '10002', configId: 'source-b' };
    f.render();
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  } finally {
    f.close();
  }
});

it('取消不清除，失败显示错误且允许重试，没有账号时禁用', async () => {
  fixture.confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
  fixture.clear.mockRejectedValue(new Error('磁盘不可写'));
  const f = mount();
  try {
    await act(async () => f.button().click());
    expect(fixture.clear).not.toHaveBeenCalled();
    await act(async () => f.button().click());
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('磁盘不可写');
    expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(f.button().disabled).toBe(false);
    fixture.config = undefined;
    f.render();
    expect(f.button().disabled).toBe(true);
  } finally {
    f.close();
  }
});

it('确认期间阻止重复操作，切换账号后不清除新账号', async () => {
  let confirm!: (value: boolean) => void;
  fixture.confirm.mockReturnValue(
    new Promise<boolean>((resolve) => {
      confirm = resolve;
    }),
  );
  const f = mount();
  try {
    act(() => f.button().click());
    expect(f.button().disabled).toBe(true);
    act(() => f.button().click());
    expect(fixture.confirm).toHaveBeenCalledOnce();
    fixture.config = { uin: '10002', configId: 'source-b' };
    f.render();
    await act(async () => confirm(true));
    expect(fixture.clear).not.toHaveBeenCalled();
    expect(f.button().disabled).toBe(false);
  } finally {
    f.close();
  }
});
