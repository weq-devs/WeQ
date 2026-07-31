/**
 * 验证 service 的 getFriendDress(好友装扮)端到端。
 *
 * 流程:取 pids[0] → probe 拿「自己」的 uin → 注入 hook → 用 WebQueryService 查
 * targetUin 正在用的装扮。凭证(skey/p_skey@vip.qq.com)由 WebCredentialProvider 走
 * native 实时取,pt4_token 之类风控 cookie 非必需。当前登录的 QQ 不必是 targetUin。
 *
 * 解析/剔除逻辑全在 packages/service/src/account/web/friend_dress.ts,这里只验证接线。
 *
 * 用法: pnpm tsx packages/service/tools/dress_page.ts [targetUin]
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const TARGET_UIN = process.argv[2] ?? '2863253201';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[dress] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录任意账号');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const myUin = info?.uin ?? '';
  console.log(`[dress] pid=${pid} 我的uin=${myUin} loggedIn=${info?.loggedIn} target=${TARGET_UIN}`);
  if (!myUin) throw new Error('probe 没拿到 uin');

  console.log(`\n[dress] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[dress] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const web = new WebQueryService(nt, { context: { uin: myUin } } as unknown as AccountSession, () => pid);

  console.log(`\n[dress] ===== 查 ${TARGET_UIN} 的好友装扮 =====`);
  const dress = await web.getFriendDress(TARGET_UIN);
  if (!dress) {
    console.log('[dress] 没解析出装扮(未登录态/风控/页面改版),检查凭证或抓包。');
    return;
  }

  console.log(`[dress] targetUin=${dress.targetUin} isSvip=${dress.isSvip}`);
  console.log(`[dress] avatar=${dress.avatarUrl}`);
  console.log(`[dress] 装扮项(${dress.items.length}):`);
  console.table(dress.items);
}

main().catch((e) => {
  console.error('[dress] 失败:', e);
  process.exit(1);
});
