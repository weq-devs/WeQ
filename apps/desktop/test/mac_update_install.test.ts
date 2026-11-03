// @vitest-environment node
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, type rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAdhocSignature,
  MAC_BUNDLE_ID,
  MAC_STAGE_PREFIX,
  macAppBundle,
  officialMacArchive,
  replaceMacApp,
  validateMacUpdatePlan,
  verifyMacArchive,
  type MacUpdatePlan,
} from '../src/main/update/mac_install';

const fixture = vi.hoisted(() => ({ run: vi.fn(), rename: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: fixture.run }),
    spawn: fixture.spawn,
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  fixture.rename.mockImplementation(actual.rename);
  return { ...actual, rename: fixture.rename };
});

const roots: string[] = [];
let realRename: typeof rename;
beforeEach(async () => {
  realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .rename;
  fixture.rename.mockReset().mockImplementation(realRename);
  fixture.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  fixture.run.mockReset().mockImplementation(async (command: string, args: string[]) => ({
    stdout:
      command === '/usr/bin/plutil'
        ? ({
            CFBundleIdentifier: MAC_BUNDLE_ID,
            CFBundleShortVersionString: args.at(-1)?.includes(MAC_STAGE_PREFIX) ? '1.1.0' : '1.0.0',
            CFBundleExecutable: 'weQ',
          }[args[1] ?? ''] ?? '')
        : '',
    stderr: '',
  }));
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'weq-mac-update-'));
  roots.push(root);
  return root;
}
async function planFixture(): Promise<MacUpdatePlan> {
  const root = await directory();
  const staging = await mkdtemp(join(root, MAC_STAGE_PREFIX));
  const target = join(root, 'weQ.app');
  await mkdir(target);
  await mkdir(join(staging, 'weQ.app'));
  await writeFile(join(target, 'version'), 'old');
  await writeFile(join(staging, 'weQ.app', 'version'), 'new');
  return {
    target,
    staging,
    version: '1.1.0',
    previousVersion: '1.0.0',
    arch: 'arm64',
    report: join(root, 'result.json'),
  };
}

describe('macOS 更新可信来源', () => {
  const version = '1.1.0';
  const name = `weQ-${version}-mac-arm64.zip`;
  const sha256 = 'a'.repeat(64);
  const release = () => ({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{ name, state: 'uploaded', digest: `sha256:${sha256}`, size: 3 }],
  });
  it('识别真正的 ad-hoc 签名，不把其他签名或错误当成 ad-hoc', () => {
    expect(isAdhocSignature('Identifier=app.weq.desktop\nSignature=adhoc\n')).toBe(true);
    expect(isAdhocSignature('Authority=Developer ID Application\nTeamIdentifier=TEST')).toBe(false);
    expect(isAdhocSignature('code object is not signed at all')).toBe(false);
  });
  it('只接受官方同版本、同架构、已上传资产的 SHA-256', () => {
    expect(officialMacArchive(release(), version, name)).toEqual({
      arch: 'arm64',
      sha256,
      size: 3,
    });
    expect(() => officialMacArchive(release(), '2.0.0', name)).toThrow('版本');
    expect(() => officialMacArchive(release(), version, `weQ-${version}-mac-x64.zip`)).toThrow(
      'SHA-256',
    );
    expect(() => officialMacArchive({ ...release(), draft: true }, version, name)).toThrow();
    expect(() =>
      officialMacArchive(
        { ...release(), assets: [{ ...release().assets[0], digest: null }] },
        version,
        name,
      ),
    ).toThrow('SHA-256');
    expect(() =>
      officialMacArchive(
        { ...release(), assets: [{ ...release().assets[0], digest: 'sha512:untrusted' }] },
        version,
        name,
      ),
    ).toThrow('SHA-256');
  });
  it('流式验证真实字节，大小相同但内容变化也拒绝', async () => {
    const archive = join(await directory(), name);
    await writeFile(archive, 'abc');
    const expected = { sha256: createHash('sha256').update('abc').digest('hex'), size: 3 };
    await expect(verifyMacArchive(archive, expected)).resolves.toBeUndefined();
    await writeFile(archive, 'abd');
    await expect(verifyMacArchive(archive, expected)).rejects.toThrow('SHA-256');
    await writeFile(archive, 'abcd');
    await expect(verifyMacArchive(archive, expected)).rejects.toThrow('大小');
  });
  it('拒绝开发 Electron 壳、任意应用及跨目录安装计划', () => {
    expect(macAppBundle('/Applications/weQ.app/Contents/MacOS/weQ')).toBe('/Applications/weQ.app');
    expect(() => macAppBundle('/Applications/Electron.app/Contents/MacOS/Electron')).toThrow();
    expect(() =>
      validateMacUpdatePlan({
        target: '/Applications/weQ.app',
        staging: '/tmp/stage',
        version,
        previousVersion: '1.0.0',
        arch: 'arm64',
        report: '/tmp/report',
      }),
    ).toThrow('路径');
  });
});

describe('macOS 退出后原位替换', () => {
  it('真实子进程从替换后的目录执行新文件，并清除 Node 模式环境变量', async () => {
    const plan = await planFixture();
    const executableDir = join(plan.staging, 'weQ.app/Contents/MacOS');
    await mkdir(executableDir, { recursive: true });
    const receipt = join(plan.staging, 'launched.json');
    await writeFile(
      join(executableDir, 'weQ'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({file: __filename, nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null}));\n`,
      { mode: 0o700 },
    );
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    fixture.spawn.mockImplementation(actual.spawn);
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    try {
      await replaceMacApp(plan);
      let observation: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          observation = await readFile(receipt, 'utf8');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(observation).toBeDefined();
      expect(JSON.parse(observation!)).toEqual({
        file: await realpath(join(plan.target, 'Contents/MacOS/weQ')),
        nodeMode: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('直接启动新 bundle 的可执行文件，不沿用系统缓存中的旧壳，也不继承助手的 Node 模式', async () => {
    const plan = await planFixture();
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    try {
      await replaceMacApp(plan);
      expect(fixture.spawn).toHaveBeenCalledWith(join(plan.target, 'Contents/MacOS/weQ'), [], {
        detached: true,
        stdio: 'ignore',
        env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }),
      });
      expect(fixture.run.mock.calls.some(([command]) => command === '/usr/bin/open')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('先严格验证两个 bundle，再替换并重启；旧应用留到新版本确认启动', async () => {
    const plan = await planFixture();
    await replaceMacApp(plan);
    expect(await readFile(join(plan.target, 'version'), 'utf8')).toBe('new');
    expect(await readFile(join(plan.staging, 'previous.app', 'version'), 'utf8')).toBe('old');
    expect(fixture.run).toHaveBeenCalledWith(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', join(plan.staging, 'weQ.app')],
      { timeout: 120_000 },
    );
    expect(fixture.run).toHaveBeenCalledWith('/usr/bin/lipo', [
      '-verify_arch',
      'arm64',
      join(plan.staging, 'weQ.app/Contents/MacOS/weQ'),
    ]);
    expect(fixture.spawn).toHaveBeenCalledWith(
      join(plan.target, 'Contents/MacOS/weQ'),
      [],
      expect.objectContaining({ detached: true }),
    );
  });
  it('新应用签名损坏时完全不移动原应用', async () => {
    const plan = await planFixture();
    fixture.run.mockRejectedValueOnce(new Error('签名损坏'));
    await expect(replaceMacApp(plan)).rejects.toThrow('签名损坏');
    expect(fixture.rename).not.toHaveBeenCalled();
    expect(await readFile(join(plan.target, 'version'), 'utf8')).toBe('old');
  });
  it('等待安装时已有另一版本覆盖原应用，不用旧计划降级它', async () => {
    const plan = await planFixture();
    const run = fixture.run.getMockImplementation();
    fixture.run.mockImplementation(async (command, args, options) => {
      if (command === '/usr/bin/plutil' && args[1] === 'CFBundleShortVersionString')
        return { stdout: '2.0.0', stderr: '' };
      return run?.(command, args, options);
    });
    await expect(replaceMacApp(plan)).rejects.toThrow('版本');
    expect(fixture.rename).not.toHaveBeenCalled();
  });
  it('新目录替换失败时恢复原路径，不能留下缺失的应用', async () => {
    const plan = await planFixture();
    fixture.rename.mockImplementation(async (from, to) => {
      if (from === join(plan.staging, 'weQ.app')) throw new Error('合成 rename 失败');
      return realRename(from, to);
    });
    await expect(replaceMacApp(plan)).rejects.toThrow('rename');
    expect(await readFile(join(plan.target, 'version'), 'utf8')).toBe('old');
  });
  it('系统拒绝启动时回退旧应用，保留失败的新版本供排查', async () => {
    const plan = await planFixture();
    fixture.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit('error', new Error('合成启动失败')));
      return child;
    });
    await expect(replaceMacApp(plan)).rejects.toThrow('启动失败');
    expect(await readFile(join(plan.target, 'version'), 'utf8')).toBe('old');
    expect(await readFile(join(plan.staging, 'failed.app', 'version'), 'utf8')).toBe('new');
  });
  it('恢复也失败时报告旧应用实际保存路径，不删除任一副本', async () => {
    const plan = await planFixture();
    fixture.rename
      .mockImplementationOnce(realRename)
      .mockRejectedValue(new Error('合成文件系统失败'));
    await expect(replaceMacApp(plan)).rejects.toThrow(join(plan.staging, 'previous.app'));
    expect(await readFile(join(plan.staging, 'previous.app', 'version'), 'utf8')).toBe('old');
    expect(await readFile(join(plan.staging, 'weQ.app', 'version'), 'utf8')).toBe('new');
  });
});
