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
  instanceArg,
  instanceDirectories,
  instanceTarget,
  prepareInstanceAccount,
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
