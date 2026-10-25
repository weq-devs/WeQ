// @vitest-environment node
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAC_BUNDLE_ID,
  MAC_STAGE_PREFIX,
  verifyMacArchive,
  verifyMacBundle,
  type MacUpdatePlan,
} from '../src/main/update/mac_install';

const run = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
const nativeArch = process.arch === 'arm64' ? 'arm64' : 'x64';

async function signedApp(path: string, version: string) {
  await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(path, 'Contents/Resources'));
  const source = join(dirname(path), 'probe.c');
  await writeFile(source, 'int main(void) { return 0; }\n');
  await run('/usr/bin/clang', [
    '-arch',
    nativeArch === 'arm64' ? 'arm64' : 'x86_64',
    source,
    '-o',
    join(path, 'Contents/MacOS/probe'),
  ]);
  await writeFile(
    join(path, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${MAC_BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`,
  );
  await writeFile(join(path, 'Contents/Resources/version.txt'), version);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path]);
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-native-update-')));
  roots.push(root);
  const staging = await mkdtemp(join(root, MAC_STAGE_PREFIX));
  const target = join(root, 'weQ.app');
  const next = join(staging, 'weQ.app');
  await signedApp(target, '1.0.0');
  await signedApp(next, '1.1.0');
  const plan: MacUpdatePlan = {
    target,
    staging,
    version: '1.1.0',
    previousVersion: '1.0.0',
    arch: nativeArch,
    report: join(root, 'result.json'),
  };
  return { root, next, plan };
}
function launch(worker: string) {
  const child = fork(worker, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execPath: process.env.WEQ_MAC_UPDATE_TEST_RUNTIME ?? process.execPath,
    execArgv: [],
  });
  children.push(child);
  return child;
}
async function updateWorker(root: string) {
  if (process.env.WEQ_MAC_UPDATE_TEST_WORKER) return process.env.WEQ_MAC_UPDATE_TEST_WORKER;
  const worker = join(root, 'worker.mjs');
  await build({
    entryPoints: [resolve('src/main/update/mac_worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: worker,
  });
  return worker;
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('等待 macOS 更新助手超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// 依赖 macOS 系统 codesign / ditto / LaunchServices，不在其它系统伪造原生验收。
describe.runIf(process.platform === 'darwin')('macOS 原生更新回归（合成应用，无 QQ 数据）', () => {
  it('复现两个完整 ad-hoc 签名仍不满足旧 cdhash；独立验证接受完整新包，拒绝损坏资源', async () => {
    const { root, next, plan } = await fixture();
    await verifyMacBundle(plan.target, '1.0.0', nativeArch);
    await verifyMacBundle(next, '1.1.0', nativeArch);
    const signature = await run('/usr/bin/codesign', ['-d', '-r-', plan.target]);
    const requirement = /designated => (.+)/.exec(signature.stdout + signature.stderr)?.[1];
    expect(requirement).toContain('cdhash');
    await expect(
      run('/usr/bin/codesign', ['--verify', '-R', requirement ?? '', next]),
    ).rejects.toThrow();
    const archive = join(root, 'update.zip');
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', next, archive]);
    const sha256 =
      (await run('/usr/bin/shasum', ['-a', '256', archive])).stdout.split(' ')[0] ?? '';
    await verifyMacArchive(archive, { sha256, size: (await stat(archive)).size });
    await writeFile(join(next, 'Contents/Resources/version.txt'), 'tampered');
    await expect(verifyMacBundle(next, '1.1.0', nativeArch)).rejects.toThrow();
  });
  it('已提交但宿主仍存活时，原生助手不移动应用', async () => {
    const { root, plan } = await fixture();
    const worker = await updateWorker(root);
    const child = launch(worker);
    const ready = new Promise((resolve) => child.once('message', resolve));
    child.send({ type: 'prepare', parentPid: process.pid, plan });
    expect(await ready).toEqual({ type: 'ready' });
    const committed = new Promise((resolve) => child.once('message', resolve));
    child.send({ type: 'commit' });
    expect(await committed).toEqual({ type: 'committed' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readFile(join(plan.target, 'Contents/Resources/version.txt'), 'utf8')).toBe(
      '1.0.0',
    );
    expect(existsSync(join(plan.staging, 'previous.app'))).toBe(false);
  });
  it.each([false, true])('宿主退出后只有明确提交才替换真实签名应用：%s', async (commit) => {
    const { root, plan } = await fixture();
    const worker = await updateWorker(root);
    const parentScript = join(root, 'parent.mjs');
    await writeFile(
      parentScript,
      `import {fork} from 'node:child_process';
const child=fork(${JSON.stringify(worker)},[],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.on('message',(message)=>{
  if(message.type==='ready') { ${commit ? "child.send({type:'commit'});" : 'child.disconnect();child.unref();process.exit(0);'} }
  if(message.type==='committed') {child.disconnect();child.unref();process.exit(0);}
  if(message.type==='error') process.exit(1);
});
child.send({type:'prepare',parentPid:process.pid,plan:${JSON.stringify(plan)}});`,
    );
    const parent = launch(parentScript);
    await until(() => parent.exitCode !== null);
    expect(parent.exitCode).toBe(0);
    if (commit) {
      await until(() => existsSync(plan.report));
      await until(
        async () => JSON.parse(await readFile(plan.report, 'utf8')).phase !== 'installing',
      );
      expect(JSON.parse(await readFile(plan.report, 'utf8'))).toMatchObject({ phase: 'installed' });
      await verifyMacBundle(plan.target, plan.version, nativeArch);
      expect(
        await readFile(join(plan.staging, 'previous.app/Contents/Resources/version.txt'), 'utf8'),
      ).toBe('1.0.0');
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await readFile(join(plan.target, 'Contents/Resources/version.txt'), 'utf8')).toBe(
        '1.0.0',
      );
      expect(existsSync(plan.report)).toBe(false);
    }
  });
});
