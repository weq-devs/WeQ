// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { QqDebugCopyManager } from '../src/main/qq_debug_copy';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'darwin')(
  '真实 APFS clone / plutil / codesign 验证合成 bundle，不启动或读取 QQ',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'weq-qq-native-'));
    roots.push(home);
    const source = join(home, 'Synthetic QQ.app');
    await mkdir(join(source, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(source, 'Contents/Resources'), { recursive: true });
    await copyFile('/usr/bin/true', join(source, 'Contents/MacOS/QQ'));
    const info = join(source, 'Contents/Info.plist');
    await writeFile(
      info,
      JSON.stringify({
        CFBundleIdentifier: 'com.tencent.qq',
        CFBundleExecutable: 'QQ',
        CFBundleShortVersionString: '0.0.0',
        CFBundleVersion: '1',
        CFBundlePackageType: 'APPL',
      }),
    );
    await run('/usr/bin/plutil', ['-convert', 'xml1', info]);
    const entitlements = join(home, 'source.plist');
    await writeFile(
      entitlements,
      JSON.stringify({
        'com.apple.security.cs.allow-jit': true,
        'com.apple.security.get-task-allow': false,
      }),
    );
    await run('/usr/bin/plutil', ['-convert', 'xml1', entitlements]);
    await run('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      source,
    ]);
    const before = await readFile(join(source, 'Contents/MacOS/QQ'));
    const manager = new QqDebugCopyManager({ home, source: () => source });
    const created = await manager.perform('prepare');
    expect(created).toMatchObject({ state: 'ready', version: '0.0.0-1', runningPids: [] });
    expect(await manager.perform('verify')).toMatchObject({ state: 'ready' });
    expect(await readFile(join(source, 'Contents/MacOS/QQ'))).toEqual(before);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', created.path]);
    expect(await manager.perform('remove')).toMatchObject({ state: 'missing' });
  },
  30_000,
);
