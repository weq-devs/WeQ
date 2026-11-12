// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  openStartupAccount,
  StartupAccount,
  startupWindowLayout,
} from '../src/main/startup_account';

function fixture() {
  type Config = Parameters<typeof openStartupAccount>[0];
  type Caller = Parameters<typeof openStartupAccount>[1];
  const account = {
    configId: 'live',
    uin: '10001',
    uid: 'u_fixture',
    dbKey: 'fixture-key',
    algos: {},
    lastLoginAt: 0,
    dataDir: '/fixture/account',
  };
  const config = {
    getStartupAutoEnter: vi.fn<Config['getStartupAutoEnter']>(() => account),
    listAccountConfigs: vi.fn<Config['listAccountConfigs']>(() => [account]),
    getStartupPage: vi.fn<Config['getStartupPage']>(() => 'messages'),
  };
  const algo = { pageHmacAlgorithm: 'fixture-page', kdfHmacAlgorithm: 'fixture-kdf' };
  const caller = {
    qqDataAccess: vi.fn<Caller['qqDataAccess']>(async () => ({
      status: 'readable',
      applicationPath: '/fixture/weq',
      issues: [],
    })),
    testDatabaseKey: vi.fn<Caller['testDatabaseKey']>(async () => ({ success: true, algo })),
    openAccount: vi.fn<Caller['openAccount']>(async () => account),
    openStaticAccount: vi.fn<Caller['openStaticAccount']>(async () => account),
  };
  return { account, config, caller, algo };
}

it('不等前端挂载即开始打开，多个等待者与重复调度共享同一次任务', async () => {
  const startup = new StartupAccount();
  let finish!: () => void;
  const run = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { opened: true, page: 'messages' as const, error: null };
  });
  const task = startup.start(run);
  expect(startup.pending).toBe(true);
  expect(startup.start(run)).toBe(task);
  const waiting = startup.wait();
  const firstWindow = startup.attach();
  const reloadedWindow = startup.attach();
  await Promise.resolve();
  expect(run).toHaveBeenCalledOnce();
  finish();
  expect(await waiting).toEqual(await task);
  expect(startup.pending).toBe(false);
  expect(await firstWindow).toMatchObject({ opened: true, page: 'messages' });
  expect(await reloadedWindow).toMatchObject({ opened: true, page: null });
  expect(run).toHaveBeenCalledOnce();
});

it('自动进入目标有效时直接创建工作区尺寸，跳过、失效、已失败不提前放大', () => {
  const { config } = fixture();
  expect(startupWindowLayout(false, true, config)).toBe('chat');
  expect(startupWindowLayout(false, false, config)).toBe('home');
  config.getStartupAutoEnter.mockReturnValue(null);
  expect(startupWindowLayout(false, true, config)).toBe('home');
  config.getStartupAutoEnter.mockReturnValue({ configId: 'missing', uin: '10001' });
  expect(startupWindowLayout(false, true, config)).toBe('home');
  expect(startupWindowLayout(false, true, undefined)).toBe('home');
  expect(startupWindowLayout(true, false, config)).toBe('chat');
});

it('后台失败可由首屏展示，重载不重试、不重复弹错', async () => {
  const startup = new StartupAccount();
  const run = vi.fn(async () => {
    throw new Error('合成打开失败');
  });
  await startup.start(run);
  expect(await startup.attach()).toMatchObject({ opened: false, error: '合成打开失败' });
  expect(await startup.attach()).toMatchObject({ error: null });
  await startup.start(run);
  expect(run).toHaveBeenCalledOnce();
});

it('独立 Web 宿主未安排桌面任务时可直接查询，不启动任何账号', async () => {
  expect(await new StartupAccount().wait()).toEqual({ opened: false, page: null, error: null });
});

it('在线账号复用密钥验证与正式打开接口，并传入已保存 UID', async () => {
  const { config, caller, account, algo } = fixture();
  expect(await openStartupAccount(config, caller, true)).toEqual({
    opened: true,
    page: 'messages',
    error: null,
  });
  expect(caller.testDatabaseKey).toHaveBeenCalledWith({ uin: account.uin, dbKey: account.dbKey });
  expect(caller.openAccount).toHaveBeenCalledWith({
    uin: account.uin,
    uid: account.uid,
    dbKey: account.dbKey,
    dataDir: account.dataDir,
    algo,
  });
  expect(caller.openStaticAccount).not.toHaveBeenCalled();
});

it.each([null, { configId: 'missing', uin: '10001' }])(
  '没有有效目标或跳过一次时不打开账号：%s',
  async (target) => {
    const { config, caller } = fixture();
    config.getStartupAutoEnter.mockReturnValue(target);
    expect(await openStartupAccount(config, caller, true)).toMatchObject({ opened: false });
    expect(caller.qqDataAccess).not.toHaveBeenCalled();
    expect(caller.testDatabaseKey).not.toHaveBeenCalled();
    expect(caller.openAccount).not.toHaveBeenCalled();
  },
);

it.each(['denied', 'error'] as const)(
  'Mac 数据读取%s时保留首页访问提示，不打开库',
  async (status) => {
    const { config, caller } = fixture();
    caller.qqDataAccess.mockResolvedValue({ status, applicationPath: '/fixture/weq', issues: [] });
    expect(await openStartupAccount(config, caller, true)).toMatchObject({ opened: false });
    expect(caller.testDatabaseKey).not.toHaveBeenCalled();
  },
);

it('密钥不正确不调用打开接口，错误传给启动任务', async () => {
  const { config, caller } = fixture();
  caller.testDatabaseKey.mockResolvedValue({ success: false, error: '合成密钥错误' });
  await expect(openStartupAccount(config, caller, false)).rejects.toThrow('合成密钥错误');
  expect(caller.qqDataAccess).not.toHaveBeenCalled();
  expect(caller.openAccount).not.toHaveBeenCalled();
});

it('静态手机备份仍走正式探测入口，不依赖在线 QQ 或 Mac 数据目录', async () => {
  const { config, caller, account, algo } = fixture();
  config.listAccountConfigs.mockReturnValue([
    { ...account, static: true, mobile: true, algos: { 'nt_msg.db': algo } },
  ]);
  await openStartupAccount(config, caller, true);
  expect(caller.openStaticAccount).toHaveBeenCalledWith({
    dirPath: account.dataDir,
    preview: { uin: account.uin, uid: account.uid, displayName: '', avatarUrl: '' },
    dbKey: account.dbKey,
    algo,
    mobile: true,
  });
  expect(caller.qqDataAccess).not.toHaveBeenCalled();
  expect(caller.testDatabaseKey).not.toHaveBeenCalled();
  expect(caller.openAccount).not.toHaveBeenCalled();
});

it('静态备份目录缺失时报告错误，不猜目录或打开其他来源', async () => {
  const { config, caller, account } = fixture();
  config.listAccountConfigs.mockReturnValue([{ ...account, static: true, dataDir: undefined }]);
  await expect(openStartupAccount(config, caller, false)).rejects.toThrow('缺少数据库目录');
  expect(caller.openStaticAccount).not.toHaveBeenCalled();
  expect(caller.openAccount).not.toHaveBeenCalled();
});
