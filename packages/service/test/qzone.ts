/**
 * 验证 QQ 空间读接口(说说列表 / 好友动态)。
 *
 * 简化处理:取 pids[0] → probe 拿登录 uin → 注入 hook → 用 WebQueryService 拉
 * 目标空间的说说,再拉本账号的好友动态。凭证(skey/p_skey)走 native,g_tk/bkn
 * 在 ts 侧算。
 *
 * 用法: pnpm tsx packages/service/test/qzone.ts [targetUin]
 *   targetUin 默认 1193368126(要拉说说的目标空间;需本账号有权限查看)。
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const TARGET = process.argv[2] ?? '1193368126';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[qzone] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[qzone] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn} target=${TARGET}`);
  if (!uin) throw new Error('probe 没拿到 uin');

  console.log(`\n[qzone] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[qzone] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const web = new WebQueryService(nt, { context: { uin } } as unknown as AccountSession, () => pid);

  console.log(`\n[qzone] ===== 说说列表 (uin=${TARGET}, pos=0, num=20) =====`);
  const msg = await web.getQzoneMsgList(TARGET, 0, 20);
  console.log(`[qzone] 说说总数(total): ${msg.total}  本页拿到: ${msg.list.length} 条`);
  console.dir(msg.list, { depth: null });

  console.log('\n[qzone] ===== 好友动态 (本账号, pageNum=1, count=10) =====');
  const feeds = await web.getQzoneFeeds(undefined, 1, 10);
  console.log(`[qzone] 动态数: ${feeds.feeds.length}  hasMore=${feeds.hasMore}`);
  // html blob 很长,打印时截断,只看结构化字段 + html 长度。
  console.dir(
    feeds.feeds.map((f) => ({ ...f, html: `<${f.html.length} chars>` })),
    { depth: null },
  );
}

main().catch((e) => {
  console.error('[qzone] 失败:', e);
  process.exit(1);
});
