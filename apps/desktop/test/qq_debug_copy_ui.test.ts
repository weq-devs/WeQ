import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QqDebugCopy } from '../src/renderer/src/components/QqDebugCopy';
import { RestrictedQqAction } from '../src/renderer/src/components/RestrictedQqAction';
import { useDialog } from '../src/renderer/src/components/Dialog';
import type { QqDebugCopyStatus } from '../src/shared/qq_debug_copy';

const f = vi.hoisted(() => ({
  data: undefined as QqDebugCopyStatus | undefined,
  action: vi.fn(),
  refetch: vi.fn(),
  confirm: vi.fn(),
  permission: vi.fn(),
  copy: vi.fn(),
  error: null as Error | null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      qqDebugCopyStatus: { useQuery: () => ({ data: f.data, error: f.error, refetch: f.refetch }) },
    },
  },
  client: {
    bootstrap: {
      qqDebugCopyAction: { mutate: f.action },
      qqDebugCopyPermission: { mutate: f.permission },
    },
  },
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
    sourceRunningPids: [],
    message: '尚未创建 QQ 调试副本。',
  };
  f.error = null;
  f.action.mockReset().mockResolvedValue(f.data);
  f.refetch.mockReset().mockResolvedValue({ data: f.data });
  f.confirm.mockReset().mockResolvedValue(true);
  f.permission.mockReset().mockResolvedValue(true);
  f.copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: f.copy },
  });
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
it('已运行不推断账号登录，可登录其他账号，仍禁止更新和移除', async () => {
  f.data!.state = 'ready';
  f.data!.runningPids = [42];
  const v = await mount();
  expect(v.host.textContent).toContain('正在运行，登录状态待检查');
  expect(v.button('登录其他账号').disabled).toBe(false);
  await act(async () => v.button('登录其他账号').click());
  expect(f.action).toHaveBeenCalledWith({ action: 'launch' });
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
it('创建前说明授权差异，创建和更新后不打断流程，权限引导可按需打开', async () => {
  const v = await mount();
  expect(v.host.textContent).toContain('原版 QQ 的授权不一定适用于副本');
  expect(v.host.querySelector('[aria-label="副本权限引导"]')).toBeNull();
  await act(async () => v.button('创建副本').click());
  expect(v.host.querySelector('[aria-label="副本权限引导"]')).toBeNull();
  expect(f.permission).not.toHaveBeenCalled();
  f.data!.state = 'ready';
  await v.render();
  await act(async () => v.button('更新副本').click());
  expect(v.host.querySelector('[aria-label="副本权限引导"]')).toBeNull();
  await act(async () => v.button('权限设置').click());
  expect(v.host.querySelector('[aria-label="副本权限引导"]')).not.toBeNull();
});
it('已创建副本可随时打开引导，选择权限并定位、复制固定副本路径；不误报授权成功', async () => {
  f.data!.state = 'ready';
  const v = await mount();
  await act(async () => v.button('权限设置').click());
  await act(async () => v.button('打开录屏设置').click());
  expect(f.permission).toHaveBeenLastCalledWith({ action: 'screenCapture' });
  const select = v.host.querySelector('select')!;
  await act(async () => {
    select.value = 'microphone';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => v.button('打开麦克风设置').click());
  expect(f.permission).toHaveBeenLastCalledWith({ action: 'microphone' });
  await act(async () => {
    select.value = 'camera';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => v.button('打开摄像头设置').click());
  expect(f.permission).toHaveBeenLastCalledWith({ action: 'camera' });
  await act(async () => v.button('在访达中显示副本').click());
  expect(f.permission).toHaveBeenLastCalledWith({ action: 'reveal' });
  await act(async () => v.button('复制副本路径').click());
  expect(f.copy).toHaveBeenCalledWith(f.data!.path);
  expect(v.host.textContent).toContain('待确认');
  expect(v.host.querySelector('.weq-qq-debug-permissions-head')?.textContent).toBe(
    '副本权限待确认',
  );
  expect(f.action).not.toHaveBeenCalled();
});
it('权限引导在副本运行时要求手动退出，不退出原版；停止后沿用固定副本启动操作', async () => {
  f.data!.state = 'ready';
  f.data!.runningPids = [42];
  const v = await mount();
  await act(async () => v.button('权限设置').click());
  expect(v.button('授权后启动副本').disabled).toBe(true);
  expect(v.host.textContent).toContain('稍后');
  expect(v.host.textContent).toContain('从副本菜单退出 QQ');
  expect(f.action).not.toHaveBeenCalled();
  f.data!.runningPids = [];
  await v.render();
  await act(async () => v.button('授权后启动副本').click());
  expect(f.action).toHaveBeenCalledWith({ action: 'launch' });
  expect(v.host.textContent).toContain('待确认');
});
it('打开系统设置或复制失败保留引导并显示错误，不执行权限重置', async () => {
  f.data!.state = 'ready';
  f.permission.mockRejectedValue(new Error('synthetic settings failure'));
  const v = await mount();
  await act(async () => v.button('权限设置').click());
  await act(async () => v.button('打开录屏设置').click());
  expect(v.host.querySelector('[role="alert"]')?.textContent).toContain(
    'synthetic settings failure',
  );
  f.copy.mockRejectedValue(new Error('synthetic clipboard failure'));
  await act(async () => v.button('复制副本路径').click());
  expect(v.host.querySelector('[role="alert"]')?.textContent).toContain(
    'synthetic clipboard failure',
  );
  expect(v.host.querySelector('[aria-label="副本权限引导"]')).not.toBeNull();
  expect(f.action).not.toHaveBeenCalled();
});

async function mountAction(needsQq = true, busy = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onOpened = vi.fn(async () => {});
  const onEnable = vi.fn(async () => {});
  const onRetry = vi.fn(async () => {});
  await act(async () =>
    root.render(createElement(RestrictedQqAction, { needsQq, busy, onOpened, onEnable, onRetry })),
  );
  close = () => {
    act(() => root.unmount());
    host.remove();
  };
  return {
    host,
    render: async () => {
      await act(async () =>
        root.render(
          createElement(RestrictedQqAction, { needsQq, busy, onOpened, onEnable, onRetry }),
        ),
      );
    },
    onOpened,
    onEnable,
    onRetry,
    primary: () => host.querySelector<HTMLButtonElement>('.weq-restricted-actions > button')!,
  };
}
it('首次状态尚未返回也能立即打开，点击后显示检查进度并阻止重复提交', async () => {
  const result = f.data!;
  f.data = undefined;
  let finish!: (value: QqDebugCopyStatus) => void;
  f.action.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const v = await mountAction();
  expect(v.primary().textContent).toBe('打开 QQ');
  expect(v.primary().disabled).toBe(false);
  await act(async () => v.primary().click());
  expect(v.primary().textContent).toBe('正在检查 QQ');
  expect(v.primary().disabled).toBe(true);
  await act(async () => v.primary().click());
  expect(f.action).toHaveBeenCalledOnce();
  f.data = { ...result, phase: 'copying' };
  await v.render();
  expect(v.primary().textContent).toBe('正在准备 QQ');
  f.data = { ...result, phase: 'launching' };
  await v.render();
  expect(v.primary().textContent).toBe('正在打开 QQ');
  f.data = result;
  await act(async () => finish(result));
  expect(v.onOpened).toHaveBeenCalledOnce();
  expect(v.primary().disabled).toBe(false);
});
it('状态查询失败不阻断打开，明确的位置占用仍禁用主操作', async () => {
  f.data = undefined;
  f.error = new Error('synthetic status failure');
  const v = await mountAction();
  expect(v.primary().disabled).toBe(false);
  await act(async () => v.primary().click());
  expect(f.action).toHaveBeenCalledWith({ action: 'open' });
  f.data = { ...(await f.refetch()).data, state: 'unmanaged' };
  await v.render();
  expect(v.primary().disabled).toBe(true);
  expect(v.host.textContent).toContain('副本位置已被其他应用占用');
});
it('凭据启用期间仍可打开副本设置与独立的副本启动操作', async () => {
  const v = await mountAction(true, true);
  expect(v.primary().disabled).toBe(false);
  const settings = [...v.host.querySelectorAll('button')].find(
    (button) => button.textContent === '副本设置',
  )!;
  expect(settings.disabled).toBe(false);
  await act(async () => settings.click());
  expect(document.querySelector('.weq-qq-debug-modal')).not.toBeNull();
});
it('副本后台操作期间仍可查看设置，但不能重复启动', async () => {
  f.data!.phase = 'signing';
  const v = await mountAction();
  expect(v.primary().disabled).toBe(true);
  const settings = [...v.host.querySelectorAll('button')].find(
    (button) => button.textContent === '副本设置',
  )!;
  expect(settings.disabled).toBe(false);
  await act(async () => settings.click());
  expect(document.querySelector('.weq-qq-debug-modal')).not.toBeNull();
});
it('普通 QQ 在线且凭据读取中仍提供明确的切换副本入口', async () => {
  f.data!.state = 'ready';
  f.data!.sourceRunningPids = [51];
  const v = await mountAction(false, true);
  const button = [...v.host.querySelectorAll('button')].find(
    (item) => item.textContent === '退出普通 QQ 并打开副本',
  )!;
  expect(button).toBeDefined();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(f.action).toHaveBeenCalledWith({ action: 'switch' });
  expect(v.onOpened).toHaveBeenCalledOnce();
});
it.each([
  ['missing', [], '准备并打开 QQ'],
  ['ready', [], '打开 QQ'],
  ['outdated', [], '打开 QQ'],
  ['invalid', [], '修复并打开 QQ'],
  ['ready', [42], '登录其他账号'],
] as const)('精简入口按 %s 和进程状态展示单一主操作 %s', async (state, pids, label) => {
  f.data!.state = state;
  f.data!.runningPids = [...pids];
  const v = await mountAction();
  expect(v.primary().textContent).toBe(label);
  await act(async () => v.primary().click());
  expect(f.action).toHaveBeenCalledOnce();
  expect(f.action).toHaveBeenCalledWith({ action: 'open' });
  expect(v.onOpened).toHaveBeenCalledOnce();
  expect(v.host.textContent).toContain('登录后会自动继续');
  expect(v.host.querySelector('.weq-qq-debug-permissions')).toBeNull();
});
it('精简入口启动期间不重复提交，失败保留重试且不继续启用', async () => {
  let reject!: (error: Error) => void;
  f.action.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const v = await mountAction();
  await act(async () => v.primary().click());
  expect(v.primary().disabled).toBe(true);
  await act(async () => v.primary().click());
  expect(f.action).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('synthetic launch failure')));
  expect(v.host.querySelector('[role="alert"]')?.textContent).toContain('synthetic launch failure');
  expect(v.onOpened).not.toHaveBeenCalled();
  expect(v.primary().disabled).toBe(false);
  await act(async () => v.primary().click());
  expect(v.onOpened).toHaveBeenCalledOnce();
  expect(v.host.querySelector('[role="alert"]')).toBeNull();
});
it('一键入口退出期间切号卸载，迟到启动结果不继续启用', async () => {
  let finish!: (value: QqDebugCopyStatus) => void;
  f.action.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const v = await mountAction();
  await act(async () => v.primary().click());
  close();
  close = () => {};
  await act(async () => finish(f.data!));
  expect(v.onOpened).not.toHaveBeenCalled();
});
it('账号已在线时直接启用，环境查询失败不会阻断已有在线能力', async () => {
  f.data = undefined;
  f.error = new Error('synthetic environment failure');
  const v = await mountAction(false);
  expect(v.primary().textContent).toBe('启用完整功能');
  expect(v.primary().disabled).toBe(false);
  await act(async () => v.primary().click());
  expect(v.onEnable).toHaveBeenCalledOnce();
  expect(f.action).not.toHaveBeenCalled();
});
