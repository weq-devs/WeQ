// @vitest-environment node
/**
 * 渲染层切号流程（`lib/switchAccount.ts`）。
 *
 * 这是「点左上角头像」和「外部 MCP 请求」共用的唯一实现，顺序错了就会把旧账号的
 * 缓存带进新账号，或者对着已关闭的会话打查询。这里盯的是那个顺序：
 *
 *   closeAccount → 清缓存 → 清 openedUin → 开新账号 → **再清一次缓存** → 预热 → 设新 uin
 *
 * 以及两个判定：按 configId 认「是不是当前账号」（同 uin 的静态记录必须能切过去）、
 * 过渡进行中拒绝第二次切换。
 */

import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  calls: [] as string[],
  close: vi.fn(async () => {
    f.calls.push('closeAccount');
    return true;
  }),
  openAccount: vi.fn(async () => {
    f.calls.push('openAccount');
    return {};
  }),
  openStatic: vi.fn(async () => {
    f.calls.push('openStaticAccount');
    return {};
  }),
  purge: vi.fn(() => {
    f.calls.push('purge');
  }),
  warmup: vi.fn(async () => {
    f.calls.push('warmup');
  }),
  mailLeave: vi.fn(async () => true),
  begin: vi.fn((hint: string) => {
    f.calls.push(`begin:${hint}`);
  }),
  end: vi.fn(() => {
    f.calls.push('end');
  }),
  hint: vi.fn(),
  progress: vi.fn(),
  openedUin: null as string | null,
  view: 'main' as string,
  active: false,
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      closeAccount: { mutate: f.close },
      openAccount: { mutate: f.openAccount },
      openStaticAccount: { mutate: f.openStatic },
    },
  },
  trpc: { useUtils: () => ({}) },
}));

vi.mock('../src/renderer/src/lib/leaveAccount', () => ({ purgeAccountQueries: f.purge }));
vi.mock('../src/renderer/src/lib/accountWarmup', () => ({ runAccountWarmup: f.warmup }));
vi.mock('../src/renderer/src/state/mailDraft', () => ({
  confirmMailAccountLeave: f.mailLeave,
}));
vi.mock('../src/renderer/src/state/accountSwitch', () => ({
  useAccountSwitch: {
    getState: () => ({
      active: f.active,
      begin: f.begin,
      end: f.end,
      setHint: f.hint,
      setProgress: f.progress,
    }),
  },
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: {
    getState: () => ({
      openedUin: f.openedUin,
      view: f.view,
      setOpenedUin: (uin: string | null) => {
        f.openedUin = uin;
        f.calls.push(`openedUin:${uin ?? 'null'}`);
      },
      goTo: (view: string) => {
        f.view = view;
        f.calls.push(`goTo:${view}`);
      },
    }),
  },
}));

import { switchAccount } from '../src/renderer/src/lib/switchAccount';

const queryClient = {} as never;
const utils = {} as never;

const online = {
  configId: 'cfg-online',
  uin: '10001',
  dbKey: 'k',
  algos: { 'nt_msg.db': { pageHmacAlgorithm: 'a', kdfHmacAlgorithm: 'b' } },
  displayName: '合成账号甲',
};

const staticTarget = {
  configId: 'cfg-static',
  uin: '10001',
  dbKey: '',
  dataDir: '/synthetic/db',
  displayName: '合成账号甲（备份）',
  static: true,
  mobile: true,
};

function run(target: typeof online | typeof staticTarget, currentConfigId: string | null) {
  return switchAccount({
    queryClient,
    utils,
    target,
    currentConfigId,
    currentUin: '99999',
  });
}

beforeEach(() => {
  f.calls.length = 0;
  f.active = false;
  f.openedUin = '99999';
  f.view = 'main';
  for (const fn of [
    f.close,
    f.openAccount,
    f.openStatic,
    f.purge,
    f.warmup,
    f.mailLeave,
    f.begin,
    f.end,
    f.hint,
    f.progress,
  ])
    fn.mockClear();
  f.mailLeave.mockResolvedValue(true);
});

it('在线账号：关会话 → 清缓存 → 清 uin → 开新账号 → 再清缓存 → 预热 → 设新 uin', async () => {
  const result = await run(online, 'cfg-other');
  expect(result.switched).toBe(true);
  expect(f.calls).toEqual([
    'begin:正在打开 合成账号甲…',
    'closeAccount',
    'purge',
    'openedUin:null',
    'openAccount',
    'purge',
    'warmup',
    'openedUin:10001',
    'end',
  ]);
  // 预热必须排在第二次 purge 之后，否则刚灌进去的数据会被清掉。
  expect(f.calls.indexOf('warmup')).toBeGreaterThan(f.calls.lastIndexOf('purge'));
  expect(f.openAccount).toHaveBeenCalledWith({
    uin: '10001',
    dbKey: 'k',
    algo: { pageHmacAlgorithm: 'a', kdfHmacAlgorithm: 'b' },
    displayName: '合成账号甲',
  });
});

it('静态账号走 openStaticAccount 并带上 mobile 标记', async () => {
  const result = await run(staticTarget, 'cfg-online');
  expect(result.switched).toBe(true);
  expect(f.openStatic).toHaveBeenCalledWith({
    dirPath: '/synthetic/db',
    preview: {
      uin: '10001',
      uid: '',
      displayName: '合成账号甲（备份）',
      avatarUrl: '',
    },
    mobile: true,
  });
  expect(f.openAccount).not.toHaveBeenCalled();
});

it('同 uin 的另一条记录能切过去（按 configId 判重）', async () => {
  const result = await run(staticTarget, 'cfg-online');
  expect(result.switched).toBe(true);
});

it('目标就是当前账号时什么都不做', async () => {
  const result = await run(online, 'cfg-online');
  expect(result).toEqual({ switched: false, reason: 'same-account' });
  expect(f.calls).toEqual([]);
});

it('configId 未知时退回按 uin 判重', async () => {
  // currentUin 是 99999；目标 uin 与之相同、configId 又没取到 → 认定是同一个账号。
  const result = await run({ ...online, uin: '99999' }, null);
  expect(result).toEqual({ switched: false, reason: 'same-account' });
  expect(f.calls).toEqual([]);
});

it('用户取消邮件确认则不切', async () => {
  f.mailLeave.mockResolvedValue(false);
  const result = await run(online, 'cfg-other');
  expect(result).toEqual({ switched: false, reason: 'cancelled' });
  expect(f.calls).toEqual([]);
});

it('已有切号在进行时拒绝第二次', async () => {
  f.active = true;
  const result = await run(online, 'cfg-other');
  expect(result).toEqual({ switched: false, reason: 'busy' });
  expect(f.calls).toEqual([]);
});

it('开账号失败：清缓存、回首页、结束过渡，并把错误交给调用方', async () => {
  const onError = vi.fn();
  f.openAccount.mockImplementationOnce(async () => {
    throw new Error('数据库密钥不正确');
  });
  const result = await switchAccount({
    queryClient,
    utils,
    target: online,
    currentConfigId: 'cfg-other',
    currentUin: '99999',
    onError,
  });
  expect(result).toEqual({ switched: false, reason: 'failed' });
  expect(f.view).toBe('bootstrap');
  expect(f.openedUin).toBeNull();
  expect(onError).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
  expect(f.calls).not.toContain('warmup');
});
