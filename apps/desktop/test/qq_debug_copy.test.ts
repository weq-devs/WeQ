// @vitest-environment node
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { QqDebugCopyManager, debugCopyPids } from '../src/main/qq_debug_copy';
import type { OwnedChildOptions, OwnedChildResult } from '@weq/service';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'weq-qq-debug-test-'));
  roots.push(home);
  const source = join(home, 'Original QQ.app');
  const target = join(home, 'Applications/QQ-WeQ.app');
  const entPath = (path: string) => join(path, 'Contents/Resources/entitlements.json');
  const infoPath = (path: string) => join(path, 'Contents/Info.plist');
  const info = {
    CFBundleIdentifier: 'com.tencent.qq',
    CFBundleExecutable: 'QQ',
    CFBundleShortVersionString: '7.0.1',
    CFBundleVersion: '1',
  };
  await mkdir(join(source, 'Contents/Resources'), { recursive: true });
  await writeFile(infoPath(source), JSON.stringify(info));
  await writeFile(
    entPath(source),
    JSON.stringify({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.get-task-allow': false,
    }),
  );
  let processes = '';
  let failSigning = false;
  let failOpening = false;
  let blockCopy: (() => Promise<void>) | undefined;
  let readerReady = true;
  const run = vi.fn(
    async (
      command: string,
      args: readonly string[],
      options?: OwnedChildOptions,
    ): Promise<OwnedChildResult> => {
      let stdout = '';
      if (command === '/bin/ps') stdout = processes;
      else if (command === '/usr/bin/plutil') {
        if (args[0] === '-extract')
          stdout = JSON.parse(await readFile(args[args.length - 1]!, 'utf8'))[args[1]!];
        else stdout = options?.input ?? '';
      } else if (command === '/bin/cp') {
        await blockCopy?.();
        await cp(args[1]!, args[2]!, { recursive: true });
      } else if (command === '/usr/bin/codesign') {
        const path = args[args.length - 1]!;
        if (args[0] === '-d')
          stdout =
            path === '/synthetic/WeQ'
              ? JSON.stringify({ 'com.apple.security.cs.debugger': readerReady })
              : await readFile(entPath(path), 'utf8');
        else if (args[0] === '--force') {
          if (failSigning)
            return { code: 1, signal: null, stdout: '', stderr: 'synthetic signing failure' };
          if (args.includes('--entitlements'))
            await writeFile(
              entPath(path),
              await readFile(args[args.indexOf('--entitlements') + 1]!),
            );
        }
      } else if (command === '/usr/bin/open') {
        if (failOpening)
          return { code: 1, signal: null, stdout: '', stderr: 'synthetic open failure' };
      } else throw new Error(`unexpected command ${command}`);
      return { code: 0, signal: null, stdout, stderr: '' };
    },
  );
  const options = {
    home,
    source: () => source,
    platform: 'darwin',
    executable: '/synthetic/WeQ',
    run,
  };
  return {
    home,
    source,
    target,
    info,
    infoPath,
    run,
    options,
    manager: new QqDebugCopyManager(options),
    processes: (value: string) => {
      processes = value;
    },
    failSign: () => {
      failSigning = true;
    },
    failOpen: () => {
      failOpening = true;
    },
    blockCopy: (value: () => Promise<void>) => {
      blockCopy = value;
    },
    noReader: () => {
      readerReady = false;
    },
  };
}
it('未创建时只检测，不写副本或启动 QQ；读取端权限单独报告', async () => {
  const f = await fixture();
  f.noReader();
  expect(await f.manager.status()).toMatchObject({
    state: 'missing',
    readerReady: false,
    phase: 'idle',
  });
  expect(
    f.run.mock.calls.every(([command]) => !['/bin/cp', '/usr/bin/open'].includes(command)),
  ).toBe(true);
});
it('准备副本保留原 entitlement，只在副本增加 get-task-allow，校验后才提交', async () => {
  const f = await fixture();
  const before = await readFile(join(f.source, 'Contents/Resources/entitlements.json'), 'utf8');
  expect(await f.manager.perform('prepare')).toMatchObject({
    state: 'ready',
    version: '7.0.1-1',
    readerReady: true,
  });
  expect(await readFile(join(f.source, 'Contents/Resources/entitlements.json'), 'utf8')).toBe(
    before,
  );
  expect(
    JSON.parse(await readFile(join(f.target, 'Contents/Resources/entitlements.json'), 'utf8')),
  ).toEqual({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.get-task-allow': true });
  expect(f.run.mock.calls.find(([command]) => command === '/bin/cp')?.[1][0]).toBe('-cR');
  const signing = f.run.mock.calls.filter(
    ([command, args]) => command === '/usr/bin/codesign' && args[0] === '--force',
  );
  expect(signing).toHaveLength(1);
  expect(signing[0]![1]).not.toContain('--deep');
  expect(await readdir(join(f.home, 'Applications'))).toEqual(['QQ-WeQ.app']);
});
it('原安装升级后显示可更新；更新成功替换副本并清理本次暂存', async () => {
  const f = await fixture();
  await f.manager.perform('prepare');
  await writeFile(f.infoPath(f.source), JSON.stringify({ ...f.info, CFBundleVersion: '2' }));
  expect(await f.manager.status()).toMatchObject({ state: 'outdated', sourceVersion: '7.0.1-2' });
  expect(await f.manager.perform('prepare')).toMatchObject({ state: 'ready', version: '7.0.1-2' });
  expect(await readdir(join(f.home, 'Applications'))).toEqual(['QQ-WeQ.app']);
});
it('旧签名副本提示修复且不再启动，重新准备后恢复可用', async () => {
  const f = await fixture();
  await f.manager.perform('prepare');
  await writeFile(
    join(f.target, 'Contents/Resources/weq-debug-copy.json'),
    JSON.stringify({ format: 1, source: f.source, sourceVersion: '7.0.1-1' }),
  );
  expect(await f.manager.status()).toMatchObject({ state: 'invalid' });
  await expect(f.manager.perform('launch')).rejects.toThrow('旧签名方式');
  expect(f.run.mock.calls.some(([command]) => command === '/usr/bin/open')).toBe(false);
  expect(await f.manager.perform('prepare')).toMatchObject({ state: 'ready' });
});
it('复制期间原安装更新时停止提交，不把混合版本副本显示为就绪', async () => {
  const f = await fixture();
  f.blockCopy(async () => {
    await writeFile(f.infoPath(f.source), JSON.stringify({ ...f.info, CFBundleVersion: '2' }));
  });
  await expect(f.manager.perform('prepare')).rejects.toThrow('准备期间发生更新');
  expect(await f.manager.status()).toMatchObject({ state: 'missing', phase: 'idle' });
  expect(await readdir(join(f.home, 'Applications'))).toEqual([]);
});
it('重建签名失败保留旧副本、原安装并释放锁，可再次校验', async () => {
  const f = await fixture();
  await f.manager.perform('prepare');
  f.failSign();
  await expect(f.manager.perform('prepare')).rejects.toThrow('synthetic signing failure');
  expect(await f.manager.perform('verify')).toMatchObject({ state: 'ready', phase: 'idle' });
  expect(await readdir(join(f.home, 'Applications'))).toEqual(['QQ-WeQ.app']);
});
it.each(['prepare', 'remove'] as const)(
  '副本运行中禁止 %s，不停止原安装或其他进程',
  async (action) => {
    const f = await fixture();
    await f.manager.perform('prepare');
    f.processes(` 42 ${f.target}/Contents/MacOS/QQ\n 43 /Applications/QQ.app/Contents/MacOS/QQ`);
    await expect(f.manager.perform(action)).rejects.toThrow('正在运行');
    expect(await f.manager.status()).toMatchObject({ state: 'ready', runningPids: [42] });
  },
);
it('非 WeQ 同名应用不覆盖、不移除、不启动', async () => {
  const f = await fixture();
  await mkdir(f.target, { recursive: true });
  await writeFile(join(f.target, 'personal-original'), 'keep');
  expect(await f.manager.status()).toMatchObject({ state: 'unmanaged' });
  for (const action of ['prepare', 'remove', 'launch'] as const)
    await expect(f.manager.perform(action)).rejects.toThrow('非 WeQ');
  expect(await readFile(join(f.target, 'personal-original'), 'utf8')).toBe('keep');
});
it('复制期间同名位置被其他应用占用时保留新到的原件，不覆盖提交', async () => {
  const f = await fixture();
  f.blockCopy(async () => {
    await mkdir(f.target);
    await writeFile(join(f.target, 'personal-original'), 'keep');
  });
  await expect(f.manager.perform('prepare')).rejects.toThrow('位置发生变化');
  expect(await readFile(join(f.target, 'personal-original'), 'utf8')).toBe('keep');
});
it('移除只删管理的副本，原安装和数据目录保留', async () => {
  const f = await fixture();
  await f.manager.perform('prepare');
  await mkdir(join(f.home, 'QQ-data'));
  await writeFile(join(f.home, 'QQ-data/chat'), 'synthetic data');
  expect(await f.manager.perform('remove')).toMatchObject({ state: 'missing' });
  expect(await readFile(f.infoPath(f.source), 'utf8')).toContain('com.tencent.qq');
  expect(await readFile(join(f.home, 'QQ-data/chat'), 'utf8')).toBe('synthetic data');
});
it('单实例和跨实例重复操作都不并行创建；进行中可查询真实阶段', async () => {
  const f = await fixture();
  let release = () => {};
  let copied = () => {};
  const began = new Promise<void>((resolve) => {
    copied = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.blockCopy(async () => {
    copied();
    await gate;
  });
  const task = f.manager.perform('prepare');
  await began;
  try {
    expect(await f.manager.status()).toMatchObject({ phase: 'copying', state: 'missing' });
    await expect(f.manager.perform('prepare')).rejects.toThrow('等待');
    await expect(new QqDebugCopyManager(f.options).perform('prepare')).rejects.toThrow('锁目录');
  } finally {
    release();
    await task;
  }
});
it('启动使用精确副本路径；失败不报告已运行，也不继承 Electron Node 开关', async () => {
  const f = await fixture();
  await f.manager.perform('prepare');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  try {
    expect(await f.manager.perform('launch')).toMatchObject({ runningPids: [] });
    const opened = f.run.mock.calls.find(([command]) => command === '/usr/bin/open')!;
    expect(opened[1]).toEqual(['-n', '-a', f.target]);
    expect(opened[2]?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    f.failOpen();
    await expect(f.manager.perform('launch')).rejects.toThrow('synthetic open failure');
  } finally {
    vi.unstubAllEnvs();
  }
});
it('读取端缺少调试权限时仍能启动副本，状态继续如实报告未就绪', async () => {
  const f = await fixture();
  f.noReader();
  await f.manager.perform('prepare');
  expect(await f.manager.perform('launch')).toMatchObject({
    state: 'ready',
    readerReady: false,
  });
  expect(f.run.mock.calls.find(([command]) => command === '/usr/bin/open')?.[1]).toEqual([
    '-n',
    '-a',
    f.target,
  ]);
});
it('副本路径被换为软链接时不通过校验', async () => {
  const f = await fixture();
  await f.manager.perform('prepare');
  const moved = join(f.home, 'moved.app');
  await cp(f.target, moved, { recursive: true });
  await rm(f.target, { recursive: true });
  await symlink(moved, f.target);
  await expect(f.manager.perform('verify')).rejects.toThrow('软链接');
});
it('进程归属按完整路径，不把前缀同名应用或命令参数误认成副本', () => {
  const path = '/Users/test name/Applications/QQ-WeQ.app';
  expect(
    debugCopyPids(
      `1 ${path}/Contents/MacOS/QQ\n2 ${path}.old/Contents/MacOS/QQ\n3 /bin/echo ${path}/Contents/MacOS/QQ\n4 /Applications/QQ.app/Contents/MacOS/QQ`,
      path,
    ),
  ).toEqual([1]);
  expect(
    debugCopyPids(`5 ${path}/Contents/Frameworks/QQ Helper.app/Contents/MacOS/QQ Helper`, path),
  ).toEqual([5]);
});
it('非 macOS 状态不可用且所有操作拒绝，不执行系统命令', async () => {
  const run = vi.fn();
  const manager = new QqDebugCopyManager({ source: () => null, platform: 'linux', run });
  expect(await manager.status()).toMatchObject({ supported: false });
  await expect(manager.perform('prepare')).rejects.toThrow('仅 macOS');
  expect(run).not.toHaveBeenCalled();
});
