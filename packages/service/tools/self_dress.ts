/**
 * 验证 service 的 getSelfDress(自己的全部装扮)端到端。
 *
 * 与 dress_page.ts(查他人,走 SSR 页面)的关键区别:这个端点不带 targetUin,按 cookie
 * 认人 —— 只能查自己,但**气泡(2)和字体(5/305)是真值**,那正是查他人拿不到的部分。
 *
 * 流程:取 pids[0] → probe 拿自己的 uin → 注入 hook → WebQueryService.getSelfDress()。
 * 凭证(p_skey@vip.qq.com)由 WebCredentialProvider 走 native 实时取,g_tk 从 p_skey 算。
 *
 * 用法: pnpm tsx packages/service/tools/self_dress.ts
 *   linux 需 root（ptrace 注入）: sudo -E node --import tsx packages/service/tools/self_dress.ts
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { ensureSendable } from '@weq/testkit';
import { WebQueryService } from '../src/account/web';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[self-dress] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录任意账号');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const myUin = info?.uin ?? '';
  console.log(`[self-dress] pid=${pid} 我的uin=${myUin} loggedIn=${info?.loggedIn}`);
  if (!myUin) throw new Error('probe 没拿到 uin');

  console.log('');
  await ensureSendable(nt, pid, myUin, { label: 'self-dress' });

  const web = new WebQueryService(
    nt,
    { context: { uin: myUin } } as unknown as AccountSession,
    () => pid,
  );

  console.log(`\n[self-dress] ===== 查自己(${myUin})的全部装扮 =====`);
  const dress = await web.getSelfDress();
  console.log(`[self-dress] uin=${dress.uin} 装扮项(${dress.items.length}):`);
  console.table(dress.items);

  // 这个端点存在的唯一理由就是这两类 —— 拿不到说明凭证/接口有问题,直接判失败。
  const bubble = dress.items.find((i) => i.appId === 2);
  const font = dress.items.find((i) => i.appId === 5 || i.appId === 305);
  console.log(`\n[self-dress] 气泡: ${bubble ? `${bubble.name} (itemId=${bubble.itemId})` : '(无)'}`);
  console.log(`[self-dress] 字体: ${font ? `${font.name} (itemId=${font.itemId})` : '(无)'}`);
  if (dress.items.length === 0) throw new Error('一项装扮都没拿到,检查 p_skey/g_tk');
}

main().catch((e) => {
  console.error('[self-dress] 失败:', e);
  process.exit(1);
});
