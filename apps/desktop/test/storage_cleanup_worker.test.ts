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
    protectedPaths: [worker],
    reportPath: join(root, 'maintenance/result.json'),
  };
  return { root, worker, path, plan };
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
  child.send({ type: 'prepare', parentPid: process.pid, plan: f.plan });
  await ready;
  child.send({ type: 'commit' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(existsSync(f.path)).toBe(true);
  expect(existsSync(f.plan.reportPath)).toBe(false);
});

it.each([false, true])('宿主退出时，只有收到明确提交才清除：%s', async (commit) => {
  const f = fixture();
  const harness = join(f.root, 'parent.mjs');
  writeFileSync(
    harness,
    `import {fork} from 'node:child_process';
const child=fork(${JSON.stringify(f.worker)},[],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>{${commit ? "child.send({type:'commit'},()=>{child.disconnect();process.exit(0);});" : 'child.disconnect();process.exit(0);'}});
child.send({type:'prepare',parentPid:process.pid,plan:${JSON.stringify(f.plan)}});`,
  );
  const parent = launch(harness);
  await until(() => parent.exitCode !== null);
  if (commit) {
    await until(() => existsSync(f.plan.reportPath));
    expect(existsSync(f.path)).toBe(false);
    expect(JSON.parse(readFileSync(f.plan.reportPath, 'utf8'))).toMatchObject({
      cleared: ['OCR'],
      failed: [],
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(f.path)).toBe(true);
    expect(existsSync(f.plan.reportPath)).toBe(false);
  }
});
