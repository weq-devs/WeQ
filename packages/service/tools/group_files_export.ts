/**
 * 端到端验证批量导出:递归全群 → 逐个换直链 → 并发下到临时目录。
 * 复刻 router 里 exportGroupFiles 的逻辑,但不走 IPC。
 *
 * 用法: pnpm tsx packages/service/tools/group_files_export.ts [groupCode] [outDir]
 */

import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { GroupFileService } from '../src/account/group_file';
import { MediaUrlService, downloadUrlToFile } from '../src/account/media_url';

const GROUP = Number(process.argv[2] ?? '673646675');
const OUT = process.argv[3] ?? join(tmpdir(), 'weq_group_files_test');

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');
  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[export] pid=${pid} uin=${uin} group=${GROUP} out=${OUT}`);
  await nt.injectAndGetStatusEmbedded(pid, uin);

  const session = {
    context: { uin },
    uidMap: { uidByUin: () => undefined },
  } as unknown as AccountSession;
  const files = new GroupFileService(nt, session, () => pid);
  const media = new MediaUrlService(nt, session, () => pid);

  const all = await files.listRecursive(GROUP);
  // 只下小文件,别把 65MB 的 apk 也拖下来。
  const targets = all.filter((f) => f.fileSize < 1_000_000);
  console.log(`[export] 递归 ${all.length} 个,取 <1MB 的 ${targets.length} 个来验证`);

  await mkdir(OUT, { recursive: true });
  let ok = 0;
  const failed: Array<{ name: string; error: string }> = [];

  for (const f of targets) {
    const target = join(OUT, ...f.path, f.fileName);
    try {
      const url = await media.getGroupFileUrl(GROUP, f.fileId, f.busId, f.fileName);
      await mkdir(dirname(target), { recursive: true });
      const outcome = await downloadUrlToFile(url, target);
      if (!outcome.ok) throw new Error(outcome.reason);
      const size = (await stat(target)).size;
      const match = size === f.fileSize ? 'OK' : `SIZE MISMATCH (期望 ${f.fileSize})`;
      console.log(`  [${match}] ${f.fileName} -> ${size}B`);
      ok += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  [FAIL] ${f.fileName}: ${msg}`);
      failed.push({ name: f.fileName, error: msg });
    }
  }

  console.log(`\n[export] 成功 ${ok} / ${targets.length},失败 ${failed.length}`);
  console.log(`[export] 输出目录内容:`);
  for (const name of await readdir(OUT)) console.log(`  ${name}`);
}

main().catch((e) => {
  console.error('[export] 失败:', e);
  process.exit(1);
});
