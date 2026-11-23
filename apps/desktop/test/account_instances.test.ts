// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  AccountInstances,
  accountIsRunning,
  accountLaunchArgs,
  accountPickerArg,
  accountPickerDirectories,
  accountPickerOwner,
  accountPickerTarget,
  instanceArg,
  instanceDirectories,
  instanceTarget,
  prepareAccountPicker,
  prepareInstanceAccount,
  savedInstanceAccounts,
} from '../src/main/account_instances';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-account-instances-'));
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

it('从所选旧账号配置取数据源，实例保存后沿用自己的配置', () => {
  const target = { uin: '101', configId: '101_fixture' };
  const mainAccounts = join(root, 'config', 'accounts');
  const original = join(mainAccounts, '101_fixture.json');
  const algo = { pageHmacAlgorithm: 'fixture-page', kdfHmacAlgorithm: 'fixture-kdf' };
  const source = JSON.stringify({
    uin: target.uin,
    dbKey: 'fixture-key',
    algo,
    dataDir: '/fixture/101',
    session: { pid: 123 },
  });
  mkdirSync(mainAccounts, { recursive: true });
  writeFileSync(original, source);
  expect(instanceTarget(['weq', instanceArg(target)])).toEqual(target);
  expect(() => instanceTarget(['weq', '--weq-account-instance=101:../outside'])).toThrow();
  const account = prepareInstanceAccount(root, target);
  expect(account.algos['nt_msg.db']).toEqual(algo);
  expect(account.session).toBeUndefined();
  const profile = instanceDirectories(root, target.uin);
  expect(profile).not.toEqual(instanceDirectories(root, '202'));
  const instanceConfig = join(profile.data, 'config', 'accounts', '101_fixture.json');
  writeFileSync(instanceConfig, JSON.stringify({ ...account, displayName: '独立实例' }));
  expect(prepareInstanceAccount(root, target).displayName).toBe('独立实例');
  expect(readFileSync(original, 'utf8')).toBe(source);
  writeFileSync(instanceConfig, '{');
  expect(() => prepareInstanceAccount(root, target)).toThrow('无法读取');
  expect(readFileSync(instanceConfig, 'utf8')).toBe('{');
});

it('不同账号可并行，关闭和打开失败只释放对应账号的锁', async () => {
  const first = new AccountInstances(root);
  const second = new AccountInstances(root);
  let active: string | undefined;
  const opened = () => active;
  await first.run(
    '101',
    async () => {
      active = '101';
    },
    opened,
  );
  const secondAccount = () => '202';
  await second.run('202', async () => {}, secondAccount);
  await expect(second.run('101', async () => {}, secondAccount)).rejects.toThrow('已在另一个');
  await expect(
    first.run(
      '303',
      async () => {
        throw new Error('打开失败');
      },
      opened,
    ),
  ).rejects.toThrow('打开失败');
  expect(accountIsRunning(root, '303')).toBe(false);
  expect(accountIsRunning(root, '101')).toBe(true);
  await first.run(
    null,
    async () => {
      active = undefined;
    },
    opened,
  );
  expect(accountIsRunning(root, '101')).toBe(false);
  expect(accountIsRunning(root, '202')).toBe(true);
  await second.run(
    null,
    async () => {},
    () => undefined,
  );
});

it('每次新建账号选择窗口独立保存配置并跳过现有自动进入设置', () => {
  const origin = join(root, 'origin');
  const config = {
    autoEnter: { configId: '101', uin: '101' },
    tencentFilesRootOverride: '/fixture/QQ',
    settings: { webServiceAutoStart: true, appLock: { enabled: true } },
  };
  for (const [source, uin] of [
    [root, '101'],
    [origin, '202'],
  ] as const) {
    const accounts = join(source, 'config', 'accounts');
    mkdirSync(accounts, { recursive: true });
    writeFileSync(
      join(accounts, `${uin}.json`),
      JSON.stringify({ uin, dbKey: 'fixture-key', lastLoginAt: 1, session: { pid: 123 } }),
    );
  }
  writeFileSync(join(origin, 'config.json'), JSON.stringify(config));
  const first = prepareAccountPicker(root, origin);
  const second = prepareAccountPicker(root, origin);
  expect(first).not.toBe(second);
  const args = ['electron', 'app', accountPickerArg(first)];
  expect(accountPickerTarget(args)).toBe(first);
  expect(accountLaunchArgs(args)).toEqual(['app']);
  const { data } = accountPickerDirectories(root, first);
  expect(JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))).toEqual({
    tencentFilesRootOverride: config.tencentFilesRootOverride,
    settings: { appLock: { enabled: true } },
  });
  expect(savedInstanceAccounts(data).map(({ uin, session }) => [uin, session])).toEqual([
    ['101', undefined],
    ['202', undefined],
  ]);
  rmSync(join(data, 'config', 'accounts', '202.json'));
  expect(savedInstanceAccounts(origin)).toHaveLength(1);
  expect(savedInstanceAccounts(accountPickerDirectories(root, second).data)).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(origin, 'config.json'), 'utf8'))).toEqual(config);
});

it('切换到在账号选择窗口中打开的账号时可找到实际持有窗口', async () => {
  const id = prepareAccountPicker(root, root);
  const picker = new AccountInstances(root, undefined, id);
  await picker.run(
    '101',
    async () => {},
    () => '101',
  );
  expect(accountPickerOwner(root, '101')).toBe(id);
  await picker.run(
    null,
    async () => {},
    () => undefined,
  );
  expect(accountPickerOwner(root, '101')).toBeUndefined();
  await new AccountInstances(root).run(
    '101',
    async () => expect(accountPickerOwner(root, '101')).toBeUndefined(),
    () => undefined,
  );
});

it('账号锁跨进程生效，持锁进程异常退出后可重新打开', async () => {
  const { data } = instanceDirectories(root, '101');
  const directory = dirname(data);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'owner.sqlite');
  const run = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
  `;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `${run}
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const closed = once(child, 'close');
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      closed.then(() => {
        throw new Error('持锁进程提前退出');
      }),
    ]);
    expect(accountIsRunning(root, '101')).toBe(true);
    expect(() => new AccountInstances(root).claim('101')).toThrow('已在另一个');
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  expect(accountIsRunning(root, '101')).toBe(false);
  expect(spawnSync(process.execPath, ['-e', run, path]).status).toBe(0);
});
