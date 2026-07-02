/**
 * 验证 QQ 空间读接口(说说列表 / 好友动态)。
 *
 * 简化处理:取 pids[0] → probe 拿登录 uin → 注入 hook → 用 WebQueryService 拉
 * 目标空间的说说,再拉本账号的好友动态。凭证(skey/p_skey)走 native,g_tk/bkn
 * 在 ts 侧算。
 *
 * 用法: pnpm tsx packages/service/test/qzone.ts [targetUin]
 *   targetUin 默认 3254005457(要拉说说的目标空间;需本账号有权限查看)。
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const TARGET = process.argv[2] ?? '1404137127';

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

  console.log(`\n[qzone] ===== 说说列表翻页 (uin=${TARGET}, num=20 按 pos 递增) =====`);
  const NUM = 20;
  const MAX_PAGES = 10; // 防跑飞:最多翻 10 页
  const all: Awaited<ReturnType<typeof web.getQzoneMsgList>>['list'] = [];
  let total = 0;
  let pos = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    let msg: Awaited<ReturnType<typeof web.getQzoneMsgList>>;
    try {
      msg = await web.getQzoneMsgList(TARGET, pos, NUM);
    } catch (e) {
      // pos 翻过头时服务端回 code=0 且 msglist:null → 库里按结构异常抛错。
      // 对翻页而言这就是「没有更多了」,优雅停止即可。
      console.log(`[qzone] page=${page} pos=${pos} 拉取中止(通常=没有更多): ${(e as Error).message.slice(0, 80)}`);
      break;
    }
    total = msg.total;
    console.log(`[qzone] page=${page} pos=${pos} → 本页 ${msg.list.length} 条 (total=${total}, 累计 ${all.length + msg.list.length})`);
    if (msg.list.length === 0) {
      console.log('[qzone] 本页 0 条,停止翻页。');
      break;
    }
    all.push(...msg.list);
    // 用「实际返回条数」推进游标,而不是 NUM —— 服务端每页可能少于 NUM。
    pos += msg.list.length;
    if (all.length >= total) {
      console.log('[qzone] 已拉满 total,停止翻页。');
      break;
    }
    // 翻页之间稍作停顿,降低触发风控概率。
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`[qzone] 翻页完成:累计拿到 ${all.length}/${total} 条说说`);
  console.dir(
    all.map((e) => ({ ...e, images: `<${e.images.length} imgs>`, content: e.content.slice(0, 30) })),
    { depth: null },
  );

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
