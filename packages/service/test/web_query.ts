/**
 * 验证 web cgi 查询三件套(群公告 / 群相册列表 / 群荣誉)。
 *
 * 简化处理:假定只有一个在线 QQ。取 pids[0] → probe 拿 uin → 注入 hook → 用
 * WebQueryService 拉三类数据。凭证(skey/p_skey)走 native,bkn 在 ts 侧算。
 *
 * 用法: pnpm tsx packages/service/test/web_query.ts [groupCode]
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService, HonorType } from '../src/account/web';

const GROUP = process.argv[2] ?? '1090396070';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[web] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[web] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn} group=${GROUP}`);
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[web] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[web] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const web = new WebQueryService(nt, { context: { uin } } as unknown as AccountSession, () => pid);

  console.log('\n[web] ===== 群公告 =====');
  const notices = await web.getGroupNotice(GROUP);
  console.log(`[web] 公告数: ${notices.length}`);
  console.dir(notices, { depth: null });

  console.log('\n[web] ===== 群相册列表 =====');
  const albums = await web.getGroupAlbumList(GROUP);
  console.log(`[web] 相册数: ${albums.length}`);
  console.dir(albums, { depth: null });

  console.log('\n[web] ===== 群荣誉(龙王 talkative) =====');
  const talkative = await web.getHonorList(GROUP, HonorType.Talkative);
  console.log(`[web] 龙王榜数: ${talkative.length}`);
  console.dir(talkative, { depth: null });

  console.log('\n[web] ===== 群荣誉(快乐源泉 emotion) =====');
  const emotion = await web.getHonorList(GROUP, HonorType.Emotion);
  console.log(`[web] 快乐源泉数: ${emotion.length}`);
  console.dir(emotion, { depth: null });
}

main().catch((e) => {
  console.error('[web] 失败:', e);
  process.exit(1);
});
