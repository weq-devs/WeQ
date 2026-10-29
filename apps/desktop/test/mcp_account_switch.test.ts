// @vitest-environment node
/**
 * MCP 的 `list_accounts` / `switch_account` 工具。
 *
 * 盯的是调用者能看到的那个约定：
 *
 *   - 账号用 configId 认，同 uin 的在线 / 静态两条记录互不混淆；
 *   - 目标就是当前账号时直接回 alreadyCurrent，不投递请求；
 *   - **没有界面接请求时当场报错**，而不是「调用成功但什么也没发生」；
 *   - 投递出去的是目标 configId，并且会唤起窗口。
 *
 * 真正的切号动作在渲染层（`lib/switchAccount.ts`），不在这一层测。
 */

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  currentConfigId: null as string | null,
  reveal: vi.fn(),
  subscriber: false,
  pushed: [] as Array<Record<string, unknown>>,
}));

vi.mock('@weq/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/service')>()),
  getHost: () => ({ showMainWindow: mocks.reveal }),
}));

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      accountConfig: {
        getRecord: () => (mocks.currentConfigId ? { configId: mocks.currentConfigId } : null),
      },
    },
    bootstrap: { userConfig: { listAccountConfigs: () => mocks.accounts } },
  }),
}));

vi.mock('../src/main/account_switch_bus', () => ({
  hasAccountSwitchSubscriber: () => mocks.subscriber,
  pushAccountSwitchRequest: (request: Record<string, unknown>) => mocks.pushed.push(request),
}));

import { AI_TOOLS } from '../src/main/mcp/tools';
import { isReadOnlyTool, isSandboxTool } from '../src/main/mcp/tool_permissions';

function tool(name: string) {
  const found = AI_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`没有这个工具：${name}`);
  return found;
}

beforeEach(() => {
  mocks.accounts = [
    {
      configId: 'cfg-online',
      uin: '10001',
      displayName: '合成账号甲',
      dbKey: 'k',
      algos: {},
      lastLoginAt: 200,
    },
    {
      configId: 'cfg-static',
      uin: '10001',
      displayName: '合成账号甲（备份）',
      dbKey: '',
      algos: {},
      static: true,
      mobile: true,
      lastLoginAt: 100,
    },
  ];
  mocks.currentConfigId = 'cfg-online';
  mocks.subscriber = true;
  mocks.reveal.mockReset();
  mocks.pushed.length = 0;
});

it('list_accounts 用 configId 区分同 uin 的在线 / 静态记录，并标出当前账号', async () => {
  const result = (await tool('list_accounts').run({})) as Array<Record<string, unknown>>;
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ configId: 'cfg-online', uin: '10001', current: true });
  expect(result[1]).toMatchObject({
    configId: 'cfg-static',
    uin: '10001',
    current: false,
    static: true,
    mobile: true,
  });
});

it('目标就是当前账号时不投递请求', async () => {
  const result = (await tool('switch_account').run({ configId: 'cfg-online' })) as Record<
    string,
    unknown
  >;
  expect(result).toMatchObject({ ok: true, alreadyCurrent: true, configId: 'cfg-online' });
  expect(mocks.pushed).toHaveLength(0);
});

it('切到同 uin 的另一条记录时照常投递（不能按 uin 判重）', async () => {
  const result = (await tool('switch_account').run({ configId: 'cfg-static' })) as Record<
    string,
    unknown
  >;
  expect(result).toMatchObject({ ok: true, configId: 'cfg-static', uin: '10001' });
  expect(mocks.pushed).toHaveLength(1);
  expect(mocks.pushed[0]).toMatchObject({ configId: 'cfg-static', source: 'mcp' });
  expect(mocks.reveal).toHaveBeenCalledOnce();
});

it('没有界面接请求时当场报错，不假装成功', async () => {
  mocks.subscriber = false;
  await expect(tool('switch_account').run({ configId: 'cfg-static' })).rejects.toThrow(
    '没有可用的 WeQ 界面',
  );
  expect(mocks.pushed).toHaveLength(0);
  expect(mocks.reveal).not.toHaveBeenCalled();
});

it('configId 不存在时报错并指向 list_accounts', async () => {
  await expect(tool('switch_account').run({ configId: 'nope' })).rejects.toThrow('list_accounts');
  expect(mocks.pushed).toHaveLength(0);
});

it('两个工具都进了外部 MCP 的可见集合', () => {
  expect(isReadOnlyTool('list_accounts')).toBe(true);
  expect(isReadOnlyTool('switch_account')).toBe(true);
});

it('沙箱权限拿不到 switch_account，list_accounts 仍可用', () => {
  // 切号会关掉当前会话、让本轮查询全部作废 —— 内置助手默认权限不许顺手切，
  // 必须显式开「任意权限」。
  expect(isSandboxTool('switch_account')).toBe(false);
  expect(isSandboxTool('list_accounts')).toBe(true);
});
