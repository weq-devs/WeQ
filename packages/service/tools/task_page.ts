/**
 * 验证 service 的 getFriendMutualMark(好友互动标识/任务进度)端到端。
 *
 * 流程:取 pids[0] → probe 拿「自己」的 uin → 注入 hook → 用 WebQueryService 查
 * targetUin 与你之间的互动标识(任务/特权/关系标识)。凭证(skey/p_skey@ti.qq.com)
 * 由 WebCredentialProvider 走 native 实时取,bkn 由 skey 算;当前登录的 QQ 不必是
 * targetUin。
 *
 * 解析/剔除逻辑全在 packages/service/src/account/web/friend_mutualmark.ts,
 * 这里只验证接线 + 打印有价值的信息(标识名/简介/图标/等级/进度)。
 *
 * 用法: pnpm tsx packages/service/tools/task_page.ts [--uin <targetUin>]
 *       不传 --uin 时查自己。
 */

import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService } from '../src/account/web';

const argv = process.argv.slice(2);
const uinIdx = argv.indexOf('--uin');
const TARGET_UIN = uinIdx >= 0 ? argv[uinIdx + 1] : undefined;

/** 进度描述:按标识类型选有意义的计数(次数或天数)。 */
function progressText(m: {
  count: number;
  actDays: number;
  lightupDays: number;
  threshold: number;
}): string {
  const parts: string[] = [];
  if (m.count > 0) parts.push(`计数${m.count}`);
  if (m.actDays > 0) parts.push(`累计${m.actDays}天`);
  if (m.lightupDays > 0) parts.push(`点亮${m.lightupDays}天`);
  if (m.threshold > 0) parts.push(`目标${m.threshold}`);
  return parts.length ? parts.join(' / ') : '(无进度数据)';
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[task] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录任意账号');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const myUin = info?.uin ?? '';
  console.log(`[task] pid=${pid} 我的uin=${myUin} loggedIn=${info?.loggedIn}`);
  if (!myUin) throw new Error('probe 没拿到 uin');

  const target = TARGET_UIN ?? myUin;
  console.log(`\n[task] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid, myUin);
  console.log(`[task] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const web = new WebQueryService(
    nt,
    { context: { uin: myUin } } as unknown as AccountSession,
    () => pid,
  );

  console.log(`\n[task] ===== 查 ${target} 的互动标识 =====`);
  const mark = await web.getFriendMutualMark(target);
  const frdName = mark.targetRemark || mark.targetNickname || mark.targetUin;

  console.log(`[task] 对方: ${mark.targetUin}(${frdName})`);
  console.log(
    `[task] 统计: 总数=${mark.totalNum} 已点亮=${mark.lightUpNum} ` +
      `稀有=${mark.rarityNum} 稀有点亮=${mark.rarityLightUpNum}`,
  );

  for (const cat of mark.categories) {
    console.log(`\n[task] ── 分类「${cat.name}」 ${cat.lightUpNum}/${cat.totalNum} ──`);
    for (const m of cat.marks) {
      const flags = [
        m.isLightup ? '已点亮' : '未点亮',
        m.isWearing ? '佩戴中' : '',
        m.isNew ? '新获得' : '',
        m.isDegrade ? '降级中' : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`  [${m.id}] ${m.name}${m.level > 0 ? ` Lv${m.level}` : ''}`);
      console.log(
        `      简介: ${m.intro || '(无)'}${m.nextLevelName ? ` | 下一级: ${m.nextLevelName}` : ''}`,
      );
      console.log(`      进度: ${progressText(m)}  状态: ${flags}`);
      console.log(`      图标: ${m.iconUrl || '(无)'}`);
    }
  }
}

main().catch((e) => {
  console.error('[task] 失败:', e);
  process.exit(1);
});
