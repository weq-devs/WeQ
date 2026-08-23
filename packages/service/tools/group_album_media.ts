/**
 * 列出指定群相册内的媒体列表（图片/视频）
 * （QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList）。
 *
 * 流程：取 pids[0] → probe 拿 uin → 注入 hook → 用 GroupAlbumMediaService.getMediaList
 * 拉取媒体列表（protobuf encode → native sendPacket → protobuf decode）。
 * 返回 nextAttachInfo 作为分页游标，可作第三个参数继续翻页。
 *
 * 用法: pnpm tsx packages/service/tools/group_album_media.ts <groupCode> <albumId> [attachInfo]
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { GroupAlbumMediaService } from '../src/account/group_album_media';

const GROUP = process.argv[2] ?? '673646675';
const ALBUM = process.argv[3];
const ATTACH = process.argv[4] ?? '';

async function main(): Promise<void> {
  if (!ALBUM) {
    throw new Error(
      '需要指定 albumId：pnpm tsx packages/service/tools/group_album_media.ts <groupCode> <albumId> [attachInfo]',
    );
  }

  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[group-album-media] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(
    `[group-album-media] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn} group=${GROUP} album=${ALBUM}`,
  );
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[group-album-media] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, uin);
  console.log(
    `[group-album-media] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`,
  );

  const mediaSvc = new GroupAlbumMediaService(
    nt,
    { context: { uin } } as unknown as AccountSession,
    () => pid,
  );
  const page = await mediaSvc.getMediaList(GROUP, ALBUM, ATTACH);

  console.log('\n[group-album-media] ===== 媒体列表 =====');
  console.log(
    `[group-album-media] 相册: ${page.albumName} (${page.albumId})  媒体数: ${page.mediaList.length}  next: ${page.nextAttachInfo || '(无)'}`,
  );
  console.dir(page.mediaList, { depth: null });
}

main().catch((e) => {
  console.error('[group-album-media] 失败:', e);
  process.exit(1);
});
