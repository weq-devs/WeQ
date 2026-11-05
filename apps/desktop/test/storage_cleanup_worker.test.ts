// @vitest-environment node
import { fork, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const children: ChildProcess[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weq-cleanup-worker-')));
  roots.push(root);
  const worker = join(root, 'worker.mjs');
  buildSync({
    entryPoints: [resolve('src/main/storage_cleanup_worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: worker,
  });
  const path = join(root, 'cache/ocr');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'synthetic.json'), '{}');
  const restarted = join(root, 'restarted.json');
  const restartScript = join(root, 'restart.cjs');
  const lockPath = join(root, 'maintenance/running.json');
  const reportPath = join(root, 'maintenance/result.json');
  writeFileSync(
    restartScript,
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(restarted)}, JSON.stringify({
  cacheExists: fs.existsSync(${JSON.stringify(path)}),
  lockExists: fs.existsSync(${JSON.stringify(lockPath)}),
  result: JSON.parse(fs.readFileSync(${JSON.stringify(reportPath)}, 'utf8')),
  nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
}));`,
  );
  const plan = {
    targets: [
      {
        id: 'ocr',
        path,
        label: 'OCR',
        bytes: 2,
        clearable: true,
        requiresExit: true,
        reason: 'synthetic',
        incomplete: false,
      },
    ],
    protectedPaths: [worker, restartScript],
    reportPath,
    lockPath,
  };
  const restart = { execPath: process.execPath, args: [restartScript], cwd: root };
  return { root, worker, path, plan, restart, restarted };
}
function launch(path: string): ChildProcess {
  const child = fork(path, [], {
    execPath: process.execPath,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  children.push(child);
  return child;
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待清除助手超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/**
 * 读报告，未写完时返回 `undefined`。
 *
 * `executeStorageCleanup` 用 `writeFile` 落盘，文件被创建的瞬间内容可能还是空的，
 * 只等 `existsSync` 会在 CI 上偶发读到空串（`Unexpected end of JSON input`）。
 */
function readReport(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('即使收到提交，宿主进程还活着时也不删除', async () => {
  const f = fixture();
  const child = launch(f.worker);
  const ready = new Promise((resolve) => child.once('message', resolve));
  child.send({ type: 'prepare', parentPid: process.pid, plan: f.plan, restart: f.restart });
  await ready;
  child.send({ type: 'commit' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(existsSync(f.path)).toBe(true);
  expect(existsSync(f.plan.reportPath)).toBe(false);
  expect(existsSync(f.restarted)).toBe(false);
});

async function exitParent(f: ReturnType<typeof fixture>, commit: boolean) {
  const harness = join(f.root, 'parent.mjs');
  writeFileSync(
    harness,
    `import {fork} from 'node:child_process';
// Match production: Windows non-detached grandchildren can be killed when the synthetic parent exits.
const child=fork(${JSON.stringify(f.worker)},[],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>{${commit ? "child.send({type:'commit'},()=>{child.disconnect();child.unref();process.exit(0);});" : 'child.disconnect();process.exit(0);'}});
child.send({type:'prepare',parentPid:process.pid,plan:${JSON.stringify(f.plan)},restart:${JSON.stringify(f.restart)}});`,
  );
  const parent = launch(harness);
  await until(() => parent.exitCode !== null);
  expect(parent.exitCode).toBe(0);
}

it.each([false, true])('宿主退出时，只有收到明确提交才清除并重启：%s', async (commit) => {
  const f = fixture();
  mkdirSync(join(f.root, 'maintenance'));
  writeFileSync(f.plan.lockPath, '{}');
  await exitParent(f, commit);
  if (commit) {
    await until(() => readReport(f.restarted) !== undefined);
    expect(existsSync(f.path)).toBe(false);
    expect(readReport(f.plan.reportPath)).toMatchObject({
      cleared: ['OCR'],
      failed: [],
    });
    expect(readReport(f.restarted)).toMatchObject({
      cacheExists: false,
      lockExists: false,
      nodeMode: null,
      result: { cleared: ['OCR'], failed: [] },
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(f.path)).toBe(true);
    expect(existsSync(f.plan.reportPath)).toBe(false);
    expect(existsSync(f.restarted)).toBe(false);
  }
});

it('部分清理失败也在完成后重启，保留失败结果且先移除锁', async () => {
  const f = fixture();
  f.plan.targets[0]!.clearable = false;
  await exitParent(f, true);
  await until(() => readReport(f.restarted) !== undefined);
  expect(readReport(f.restarted)).toMatchObject({
    cacheExists: true,
    lockExists: false,
    nodeMode: null,
    result: { cleared: [], failed: [{ label: 'OCR' }] },
  });
});

it('重启失败保留已完成清理结果并记录启动错误', async () => {
  const f = fixture();
  f.restart.execPath = join(f.root, 'missing-executable');
  await exitParent(f, true);
  await until(() => {
    const report = readReport(f.plan.reportPath) as
      | { failed?: Array<{ label: string }> }
      | undefined;
    return report?.failed?.some((item) => item.label === '重新启动 WeQ') ?? false;
  });
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(f.plan.lockPath)).toBe(false);
  expect(readReport(f.plan.reportPath)).toMatchObject({
    cleared: ['OCR'],
    failed: [{ label: '重新启动 WeQ' }],
  });
});

it('清理锁无法移除时记录原因，不启动会被守卫拦截的新实例', async () => {
  const f = fixture();
  mkdirSync(f.plan.lockPath, { recursive: true });
  writeFileSync(join(f.plan.lockPath, 'synthetic'), 'lock');
  await exitParent(f, true);
  await until(() => {
    const report = readReport(f.plan.reportPath) as
      | { failed?: Array<{ label: string }> }
      | undefined;
    return report?.failed?.some((item) => item.label === '解除清理锁') ?? false;
  });
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(f.restarted)).toBe(false);
  expect(readReport(f.plan.reportPath)).toMatchObject({
    cleared: ['OCR'],
    failed: [{ label: '解除清理锁' }],
  });
});
