import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QqDebugCopy } from '../src/renderer/src/components/QqDebugCopy';
import { useDialog } from '../src/renderer/src/components/Dialog';
import type { QqDebugCopyStatus } from '../src/shared/qq_debug_copy';

const f = vi.hoisted(() => ({
  data: undefined as QqDebugCopyStatus | undefined,
  action: vi.fn(),
  refetch: vi.fn(),
  confirm: vi.fn(),
  error: null as Error | null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      qqDebugCopyStatus: { useQuery: () => ({ data: f.data, error: f.error, refetch: f.refetch }) },
    },
  },
  client: { bootstrap: { qqDebugCopyAction: { mutate: f.action } } },
}));
let close = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.data = {
    supported: true,
    phase: 'idle',
    state: 'missing',
    sourcePath: '/Applications/QQ.app',
    sourceVersion: '7.0.1-1',
    path: `/Users/synthetic ${'long directory/'.repeat(8)}Applications/QQ-WeQ.app`,
    version: null,
    readerReady: true,
    runningPids: [],
    message: '尚未创建 QQ 调试副本。',
  };
  f.error = null;
  f.action.mockReset().mockResolvedValue(f.data);
  f.refetch.mockReset().mockResolvedValue({ data: f.data });
  f.confirm.mockReset().mockResolvedValue(true);
  useDialog.setState({ confirm: f.confirm });
});
afterEach(() => {
  close();
  vi.unstubAllGlobals();
});
async function mount(onCheck?: () => Promise<void>, showRetry = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(QqDebugCopy, { onCheck, showRetry }));
  await act(async () => render());
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  return {
    host,
    render: async () => {
      await act(async () => render());
    },
    button: (label: string) =>
      [...host.querySelectorAll('button')].find(
        (button) =>
          button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
      )!,
  };
}
it('打开界面只检测，缺少副本不能启动；显示读取端、签名与进程独立状态', async () => {
  const v = await mount();
  expect(f.action).not.toHaveBeenCalled();
  expect(v.button('启动副本').disabled).toBe(true);
  expect(v.host.textContent).toContain('调试权限已就绪');
  expect(v.host.textContent).toContain('未创建');
  expect(v.host.textContent).toContain('未启动');
  expect(
    [...v.host.querySelectorAll('button')].filter((button) => button.textContent === '重新检查'),
  ).toHaveLength(1);
});
it.each(['missing', 'ready'] as const)(
  '嵌入面板 %s 隐藏自身检查入口，但不影响副本管理操作',
  async (state) => {
    f.data!.state = state;
    const v = await mount(undefined, false);
    expect(v.button('重新检查')).toBeUndefined();
    expect(v.button('检查在线凭据')).toBeUndefined();
    expect(v.button('启动副本')).toBeDefined();
    expect(v.button(state === 'missing' ? '创建副本' : '更新副本')).toBeDefined();
  },
);
it('创建期间禁用重复操作，完成只提示准备好，不冒称在线凭据就绪', async () => {
  let finish = () => {};
  f.action.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const v = await mount();
  await act(async () => v.button('创建副本').click());
  expect(v.button('创建副本').disabled).toBe(true);
  await act(async () => v.button('创建副本').click());
  expect(f.action).toHaveBeenCalledOnce();
  expect(v.host.textContent).not.toContain('副本已准备好');
  await act(async () => finish());
  expect(v.host.textContent).toContain('副本已准备好，请启动并登录目标账号');
  expect(v.host.textContent).not.toContain('完整功能已恢复');
});
it('显示后台真实阶段，重开页面也不能并行操作', async () => {
  f.data!.phase = 'signing';
  const v = await mount();
  expect(v.host.textContent).toContain('正在配置调试签名');
  expect(v.button('创建副本').disabled).toBe(true);
});
it('开发宿主缺少读取权限不阻止启动已就绪副本，也不把副本当作可读', async () => {
  f.data!.state = 'ready';
  f.data!.readerReady = false;
  const v = await mount();
  expect(v.button('启动副本').disabled).toBe(false);
  expect(v.host.textContent).toContain('当前构建缺少调试权限');
  await act(async () => v.button('启动副本').click());
  expect(f.action).toHaveBeenCalledWith({ action: 'launch' });
  expect(v.host.textContent).toContain('当前构建缺少调试权限');
});
it('移除副本使用与其他操作一致的图标文字按钮', async () => {
  f.data!.state = 'ready';
  const v = await mount();
  const remove = v.button('移除副本');
  expect(remove.className).toBe(v.button('更新副本').className);
  expect(remove.textContent).toBe('移除副本');
  expect(remove.querySelector('svg')).not.toBeNull();
});
it('失败保留错误和重试入口，不显示成功；刷新查询失败不覆盖原错误', async () => {
  f.action.mockRejectedValue(new Error('synthetic codesign failure'));
  f.refetch.mockRejectedValue(new Error('synthetic refresh failure'));
  const v = await mount();
  await act(async () => v.button('创建副本').click());
  expect(v.host.querySelector('[role="alert"]')?.textContent).toContain(
    'synthetic codesign failure',
  );
  expect(v.host.textContent).not.toContain('副本已准备好');
  expect(v.button('创建副本').disabled).toBe(false);
});
it('已运行只显示进程状态，不推断账号登录；禁止更新、重复启动和移除', async () => {
  f.data!.state = 'ready';
  f.data!.runningPids = [42];
  const v = await mount();
  expect(v.host.textContent).toContain('正在运行，登录状态待检查');
  expect(v.button('启动副本').disabled).toBe(true);
  expect(v.button('更新副本').disabled).toBe(true);
  expect(v.button('移除副本').disabled).toBe(true);
});
it('移除须确认，取消不修改；通过确认后仅发出副本移除请求', async () => {
  f.data!.state = 'ready';
  const v = await mount();
  f.confirm.mockResolvedValueOnce(false);
  await act(async () => v.button('移除副本').click());
  expect(f.action).not.toHaveBeenCalled();
  await act(async () => v.button('移除副本').click());
  expect(f.action).toHaveBeenCalledWith({ action: 'remove' });
});
it('先校验副本，再沿用当前来源在线检查；启动本身不触发读取', async () => {
  f.data!.state = 'ready';
  const check = vi.fn(async () => {});
  const v = await mount(check);
  await act(async () => v.button('启动副本').click());
  expect(check).not.toHaveBeenCalled();
  await act(async () => v.button('检查在线凭据').click());
  expect(f.action).toHaveBeenLastCalledWith({ action: 'verify' });
  expect(check).toHaveBeenCalledOnce();
});
it('未知同名应用不提供覆盖或删除，查询失败保留错误状态', async () => {
  f.data!.state = 'unmanaged';
  f.error = new Error('synthetic probe failed');
  const v = await mount();
  expect(v.button('创建副本').disabled).toBe(true);
  expect(v.button('移除副本')).toBeUndefined();
  expect(v.host.querySelector('[role="alert"]')?.textContent).toContain('synthetic probe failed');
});
