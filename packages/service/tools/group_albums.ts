/**
 * 列出指定群的所有群相册（qzone web cgi：qun_list_album_v2）。
 *
 * 流程：取 pids[0] → probe 拿 uin → 注入 hook → 用 WebQueryService.getGroupAlbumList
 * 拉取相册列表。每个相册的 id 可传给 group_album_media.ts 枚举内容。
 *
 * 用法: pnpm tsx packages/service/tools/group_albums.ts [groupCode]
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const GROUP = process.argv[2] ?? '673646675';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[group-albums] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[group-albums] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn} group=${GROUP}`);
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[group-albums] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, uin);
  console.log(
    `[group-albums] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`,
  );

  const web = new WebQueryService(nt, { context: { uin } } as unknown as AccountSession, () => pid);

  console.log('\n[group-albums] ===== 群相册列表 =====');
  const albums = await web.getGroupAlbumList(GROUP);
  console.log(`[group-albums] 相册数: ${albums.length}`);
  console.dir(albums, { depth: null });
}

main().catch((e) => {
  console.error('[group-albums] 失败:', e);
  process.exit(1);
});
