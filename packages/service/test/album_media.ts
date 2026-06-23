/**
 * 验证 @weq/protocol 端到端:取某个群相册的媒体列表
 * (QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList)。
 *
 * 流程:取 pids[0] → probe uin → 注入 hook → 先用 web cgi 列出相册拿一个 albumId
 * → 再用 GroupAlbumMediaService 取该相册的媒体列表(protobuf encode → native
 * sendPacket → protobuf decode)。
 *
 * 注意:依赖 native 的 `sendPacket` 方法,需先重新编译 nt_helper 并替换 .node。
 *
 * 用法: pnpm tsx packages/service/test/album_media.ts [groupCode] [albumId]
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';
import { GroupAlbumMediaService } from '../src/account/group_album_media';

const GROUP = process.argv[2] ?? '673646675';
const ALBUM_ARG = process.argv[3];

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[album-media] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[album-media] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn} group=${GROUP}`);
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[album-media] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[album-media] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  // 取一个 albumId:命令行指定优先,否则用 web cgi 列出相册取第一个。
  let albumId = ALBUM_ARG;
  if (!albumId) {
    const web = new WebQueryService(nt, { context: { uin } } as unknown as AccountSession, () => pid);
    const albums = await web.getGroupAlbumList(GROUP);
    console.log(`[album-media] 相册数: ${albums.length}`);
    console.dir(albums, { depth: null });
    if (albums.length === 0) throw new Error('该群没有相册,换一个有相册的群再试');
    albumId = albums[0]!.id;
  }
  console.log(`\n[album-media] 目标 albumId=${albumId}`);

  const mediaSvc = new GroupAlbumMediaService(nt, { context: { uin } } as unknown as AccountSession, () => pid);
  const page = await mediaSvc.getMediaList(GROUP, albumId);

  console.log(`\n[album-media] ===== 媒体列表 =====`);
  console.log(`[album-media] 相册名: ${page.albumName}  媒体数: ${page.mediaList.length}  next: ${page.nextAttachInfo || '(无)'}`);
  console.dir(page.mediaList, { depth: null });
}

main().catch((e) => {
  console.error('[album-media] 失败:', e);
  process.exit(1);
});
