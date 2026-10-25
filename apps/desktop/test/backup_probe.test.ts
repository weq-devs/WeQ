import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { runBackupProbe } from '../src/main/backup_probe';

const roots: string[] = [];
function worker(code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-probe-child-'));
  roots.push(dir);
  const path = join(dir, 'worker.mjs');
  writeFileSync(path, code);
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const options = (workerPath: string) => ({
  workerPath,
  nativeRoot: '/synthetic/native',
  executable: process.execPath,
});
it('子进程退出 139 或信号终止时报告隔离失败，父进程还能继续下一次探测', async () => {
  for (const code of ['process.exit(139)', "process.kill(process.pid, 'SIGTERM')"]) {
    await expect(runBackupProbe({ dirPath: '/synthetic' }, options(worker(code)))).rejects.toThrow(
      '已隔离',
    );
  }
  const path = worker(
    `process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({status:'needKey'})));`,
  );
  expect(await runBackupProbe({ dirPath: '/synthetic' }, options(path))).toEqual({
    status: 'needKey',
  });
});
it('密钥经 stdin 传输而非参数；拒绝空或无效响应', async () => {
  const path = worker(
    `let input=''; for await(const c of process.stdin) input+=c; const d=JSON.parse(input); console.log(JSON.stringify({status:process.argv.includes(d.dbKey)?'error':'needKey'}));`,
  );
  expect(
    await runBackupProbe({ dirPath: '/synthetic', dbKey: 'not-in-argv' }, options(path)),
  ).toEqual({ status: 'needKey' });
  for (const code of ["console.log('{}')", 'process.exit(0)'])
    await expect(runBackupProbe({ dirPath: '/synthetic' }, options(worker(code)))).rejects.toThrow(
      '有效结果',
    );
});
it('超时和输出超限会关闭自己创建的子进程再返回错误', async () => {
  await expect(
    runBackupProbe(
      { dirPath: '/synthetic' },
      { ...options(worker('setInterval(()=>{},1000)')), timeoutMs: 100 },
    ),
  ).rejects.toThrow('超时');
  await expect(
    runBackupProbe(
      { dirPath: '/synthetic' },
      options(worker("process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)")),
    ),
  ).rejects.toThrow('超过限制');
});
