import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalRkeySection } from '../src/renderer/src/components/settings/ExternalRkeySection';
import { SsePushSection } from '../src/renderer/src/components/settings/SsePushSection';
import { McpServerSection } from '../src/renderer/src/components/settings/McpServerSection';
import { TabActivityContext } from '../src/renderer/src/components/RetainedTabs.shared';

const api = vi.hoisted(() => ({
  mode: 'ready',
  retry: vi.fn(),
  mutate: vi.fn(),
  createToken: vi.fn(),
  setAccountGrant: vi.fn(),
  mcpGrants: null as null | {
    accounts: { configId: string; displayName: string; uin: string; static: boolean }[];
    grants: { id: string; label: string; configIds: string[]; writeConfigIds?: string[] }[];
  },
  settings: {
    externalRkey: {
      servers: [
        {
          id: 'synthetic',
          name: '合成RKEY',
          baseUrl: 'https://example.invalid',
          accessToken: 'synthetic',
        },
      ],
      enabledServerId: null,
    },
    ssePush: {
      servers: [
        { id: 'synthetic', name: '合成SSE', pushUrl: 'https://example.invalid', accessToken: '' },
      ],
      enabledServerId: null,
      debounceMs: 2000,
      massThreshold: 50,
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const targets = [
    {
      key: 'synthetic',
      name: '合成客户端',
      configPath: '/synthetic',
      available: true,
      installed: false,
      upToDate: false,
    },
  ];
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'useQuery')
          return () => ({
            data:
              api.mode === 'error' || api.mode === 'loading'
                ? undefined
                : path.endsWith('getSettings')
                  ? api.settings
                  : path.endsWith('getMcpStatus')
                    ? {
                        enabled: false,
                        running: false,
                        port: 48765,
                        token: 'synthetic',
                        url: 'http://127.0.0.1:48765',
                        sharedService: api.mcpGrants !== null,
                      }
                    : path.endsWith('getMcpAccountGrants')
                      ? api.mcpGrants
                      : path.endsWith('listMcpAgentTargets')
                        ? targets
                        : '{}',
            error: ['error', 'stale'].includes(api.mode) ? Error('合成服务读取失败') : null,
            isLoading: api.mode === 'loading',
            isFetching: false,
            refetch: api.retry,
          });
        if (key === 'useMutation') return () => ({ isLoading: false, mutateAsync: api.mutate });
        if (key === 'mutate' && path.endsWith('createMcpAccountToken')) return api.createToken;
        if (key === 'mutate' && path.endsWith('setMcpAccountGrant')) return api.setAccountGrant;
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const components = { rkey: ExternalRkeySection, sse: SsePushSection, mcp: McpServerSection };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.mode = 'ready';
  api.retry.mockClear();
  api.mutate.mockClear();
  api.createToken.mockReset();
  api.setAccountGrant.mockReset();
  api.mcpGrants = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render(kind: keyof typeof components, active = true) {
  act(() =>
    root.render(
      createElement(
        TabActivityContext.Provider,
        { value: active },
        createElement(components[kind]),
      ),
    ),
  );
}
describe.each(['rkey', 'sse', 'mcp'] as const)('%s 服务设置读取状态', (kind) => {
  it('加载不冒充空服务或已停止', () => {
    api.mode = 'loading';
    render(kind);
    expect(host.textContent).toContain('正在读取');
    expect(host.textContent).not.toContain('还没有');
    expect(host.textContent).not.toContain('已停止');
    if (kind === 'mcp')
      expect(
        host.querySelector('[aria-label="启用 MCP 服务器"]')!.getAttribute('aria-checked'),
      ).toBe('mixed');
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it('失败可重试，不生成默认状态或空列表结论', () => {
    api.mode = 'error';
    render(kind);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成服务读取失败');
    expect(host.textContent).not.toContain('还没有');
    expect(host.textContent).not.toContain('没找到本机');
    expect(host.textContent).not.toContain('已停止');
    act(() => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(api.retry).toHaveBeenCalledOnce();
    if (kind === 'mcp')
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="启用 MCP 服务器"]')!.disabled,
      ).toBe(true);
    expect(api.mutate).not.toHaveBeenCalled();
    api.mode = 'ready';
    render(kind);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it('读取失败保留已有配置并显式提示', () => {
    api.mode = 'stale';
    render(kind);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      host.querySelectorAll(kind === 'mcp' ? '.weq-set-agent-item' : '.weq-set-server-item'),
    ).toHaveLength(1);
  });
});

const testAccount = { configId: 'account', displayName: '测试账号', uin: '10001', static: false };
const sameNameGrant = { id: 'existing', label: '测试客户端', configIds: [testAccount.configId] };
const newGrant = { ...sameNameGrant, id: 'created', configIds: [] };
const tokenResult = { id: newGrant.id, token: 'synthetic-once-only-token' };

function submitTokenName() {
  const input = host.querySelector<HTMLInputElement>('[aria-label="令牌名称"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
    input,
    newGrant.label,
  );
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.form!;
}

function buttonWithin(element: Element, label: string) {
  return Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent === label,
  )!;
}

it('MCP 分段选择在一次请求中为当前数据源设置指定权限', async () => {
  const backup = { ...testAccount, configId: 'backup', static: true };
  const grant = { ...sameNameGrant, configIds: [backup.configId] };
  api.mcpGrants = {
    accounts: [testAccount, backup],
    grants: [grant],
  };
  api.setAccountGrant.mockResolvedValue(undefined);
  render('mcp');

  const livePermissions = host.querySelector('[aria-label="测试客户端 · 测试账号（10001）权限"]')!;
  const backupPermissions = host.querySelector(
    '[aria-label="测试客户端 · 测试账号（10001 · 静态备份）权限"]',
  )!;
  expect(backupPermissions.querySelector('[aria-checked="true"]')?.textContent).toBe('只读');
  expect(buttonWithin(backupPermissions, '读取和操作')).toBeUndefined();

  act(() => buttonWithin(livePermissions, '不授权').click());
  expect(api.setAccountGrant).not.toHaveBeenCalled();

  await act(async () => buttonWithin(livePermissions, '读取和操作').click());
  expect(api.setAccountGrant).toHaveBeenCalledOnce();
  expect(api.setAccountGrant).toHaveBeenCalledWith({
    id: grant.id,
    configId: testAccount.configId,
    permission: 'operate',
  });
  api.mcpGrants.grants = [
    {
      ...grant,
      configIds: [backup.configId, testAccount.configId],
      writeConfigIds: [testAccount.configId],
    },
  ];
  render('mcp');
  expect(livePermissions.querySelector('[aria-checked="true"]')?.textContent).toBe('读取和操作');

  await act(async () => buttonWithin(livePermissions, '只读').click());
  expect(api.setAccountGrant).toHaveBeenLastCalledWith({
    id: grant.id,
    configId: testAccount.configId,
    permission: 'read',
  });
  await act(async () => buttonWithin(backupPermissions, '不授权').click());
  expect(api.setAccountGrant).toHaveBeenLastCalledWith({
    id: grant.id,
    configId: backup.configId,
    permission: 'none',
  });
});

it('MCP 创建结果按 ID 定位，列表尚未读回时仍可复制并收起', async () => {
  api.mcpGrants = { accounts: [testAccount], grants: [sameNameGrant] };
  api.createToken.mockResolvedValue(tokenResult);
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  render('mcp');
  let form!: HTMLFormElement;
  act(() => {
    form = submitTokenName();
  });
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  const receipt = host.querySelector('[role="group"][tabindex="-1"]')!;
  const card = receipt.closest('section')!;
  expect(document.activeElement).toBe(receipt);
  expect(card.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('不授权');
  expect(host.textContent).not.toContain(tokenResult.token);

  await act(async () => buttonWithin(receipt, '复制令牌').click());
  expect(writeText).toHaveBeenCalledWith(tokenResult.token);
  expect(buttonWithin(receipt, '已复制')).toBeDefined();
  act(() => buttonWithin(receipt, '显示令牌').click());
  expect(receipt.textContent).toContain(tokenResult.token);

  api.mcpGrants.grants = [sameNameGrant, newGrant];
  render('mcp');
  act(() => buttonWithin(receipt, '收起提示').click());
  expect(host.textContent).not.toContain(tokenResult.token);
  expect(card.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('不授权');
});

it('MCP 切出后返回时不回显上一轮在途创建的令牌', async () => {
  api.mcpGrants = { accounts: [testAccount], grants: [] };
  let finish!: (result: typeof tokenResult) => void;
  api.createToken.mockImplementation(
    () =>
      new Promise<typeof tokenResult>((resolve) => {
        finish = resolve;
      }),
  );
  render('mcp');
  let form!: HTMLFormElement;
  act(() => {
    form = submitTokenName();
  });
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  render('mcp', false);
  render('mcp');

  api.mcpGrants.grants = [newGrant];
  await act(async () => finish(tokenResult));
  expect(host.textContent).toContain(newGrant.label);
  expect(host.textContent).not.toContain('令牌已创建');
  expect(host.textContent).not.toContain(tokenResult.token);
});
it('外部 rKey 保留说明和列表，导入在独立编辑浮层内打开与关闭', () => {
  render('rkey');
  const card = host.querySelector('.weq-set-card')!;
  expect(host.querySelectorAll('.weq-set-card')).toHaveLength(1);
  expect(host.querySelector('.weq-set-head')).toBeNull();
  expect(card.querySelector('.weq-set-card-title')?.textContent).toBe('外部 rKey 服务器');
  expect(card.querySelector('.weq-set-about')).not.toBeNull();
  expect(card.querySelectorAll('.weq-set-server-item')).toHaveLength(1);
  act(() => card.querySelector<HTMLButtonElement>('.weq-set-card-action button')!.click());
  expect(host.querySelectorAll('.weq-set-card')).toHaveLength(1);
  expect(document.querySelector('.weq-editor-dialog form')?.getAttribute('aria-label')).toBe(
    '导入新配置',
  );
  expect(card.querySelectorAll('.weq-set-server-item')).toHaveLength(1);
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭导入新配置"]')!.click());
  expect(document.querySelector('.weq-editor-dialog form')).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
});
it('外部 rKey 的独立编辑表单展示已有配置', () => {
  render('rkey');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑"]')!.click());
  expect(host.querySelectorAll('.weq-set-card')).toHaveLength(1);
  expect(document.querySelector('.weq-editor-dialog form')?.getAttribute('aria-label')).toBe(
    '编辑配置',
  );
  expect(document.querySelector<HTMLInputElement>('[aria-label="RKEY HTTP 地址"]')?.value).toBe(
    api.settings.externalRkey.servers[0]!.baseUrl,
  );
  expect(document.querySelector<HTMLInputElement>('[aria-label="RKEY access_token"]')?.type).toBe(
    'password',
  );
  expect(api.mutate).not.toHaveBeenCalled();
});
it('SSE 同值重新读取不覆盖正在编辑的调优值', () => {
  render('sse');
  act(() => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="防抖毫秒"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '3500');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  api.settings = { ...api.settings, ssePush: { ...api.settings.ssePush } };
  render('sse');
  expect(host.querySelector<HTMLInputElement>('[aria-label="防抖毫秒"]')!.value).toBe('3500');
  expect(api.mutate).not.toHaveBeenCalled();
  api.settings = { ...api.settings, ssePush: { ...api.settings.ssePush, massThreshold: 75 } };
  render('sse');
  expect(host.querySelector<HTMLInputElement>('[aria-label="防抖毫秒"]')!.value).toBe('3500');
  expect(host.querySelector<HTMLInputElement>('[aria-label="大量消息阈值"]')!.value).toBe('75');
});
