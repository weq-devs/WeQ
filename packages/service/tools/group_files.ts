/**
 * 验证 GroupFileService:分目录列表 + 递归遍历全群 + 下载直链带文件名。
 *
 * 用法: pnpm tsx packages/service/tools/group_files.ts [groupCode] [folderId]
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { GroupFileService } from '../src/account/group_file';
import { MediaUrlService } from '../src/account/media_url';

const GROUP = Number(process.argv[2] ?? '673646675');
const FOLDER = process.argv[3] ?? '/';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[group-files] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(
    `[group-files] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn} group=${GROUP} dir=${FOLDER}`,
  );

  console.log(`\n[group-files] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, uin);
  console.log(
    `[group-files] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`,
  );

  const session = {
    context: { uin },
    uidMap: { uidByUin: () => undefined },
  } as unknown as AccountSession;
  const svc = new GroupFileService(nt, session, () => pid);

  console.log(`\n[group-files] ===== 目录列表 dir=${FOLDER} =====`);
  const listing = await svc.list(GROUP, FOLDER);
  console.log(
    `[group-files] 文件夹 ${listing.folders.length} 个 / 文件 ${listing.files.length} 个`,
  );
  console.dir(listing.folders, { depth: null });
  console.dir(listing.files.slice(0, 5), { depth: null });

  console.log(`\n[group-files] ===== 递归全群 =====`);
  const all = await svc.listRecursive(GROUP);
  console.log(`[group-files] 递归共 ${all.length} 个文件`);
  for (const f of all.slice(0, 30)) {
    console.log(`  ${[...f.path, f.fileName].join('/')}  (${f.fileSize}B, busId=${f.busId})`);
  }

  const first = all[0];
  if (!first) {
    console.log('\n[group-files] 没有文件,跳过下载链接验证');
    return;
  }

  console.log(`\n[group-files] ===== 下载直链: ${first.fileName} =====`);
  const media = new MediaUrlService(nt, session, () => pid);
  const url = await media.getGroupFileUrl(GROUP, first.fileId, first.busId, first.fileName);
  console.log(`[group-files] URL: ${url}`);
}

main().catch((e) => {
  console.error('[group-files] 失败:', e);
  process.exit(1);
});
