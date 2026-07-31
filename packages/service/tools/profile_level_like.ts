/**
 * 验证 @weq/protocol 的两个用户资料 OIDB:
 *   - FetchUserProfile (0xFE1_2) 取 QQ 等级等资料
 *   - GetProfileLike   (0x7ED_12) 取资料卡点赞/收藏数
 *
 * 流程:取 pids[0] → probe 拿 uin/uid → 注入 hook → 分别发两个包。
 * 不传参数时查自己;传 uin 则查该用户(等级)。
 *
 * 用法: pnpm tsx packages/service/tools/profile_level_like.ts [uin]
 */

import { loadNative } from '@weq/native';
import { FetchUserProfile, GetProfileLike } from '@weq/protocol';

const TARGET_ARG = process.argv[2];

// 0x7ED_12 按 uid 查,而端口 probe 往往不带 uid。跟其他 test 脚本一样硬编码
// 本机账号的 uid;查别人时用 0xFE1_2 响应里回带的 uid。
const SELF_UID = 'u_mGIBTBW7gF4Wocw8zapc6w';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`[profile] QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');

  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const selfUin = info?.uin ?? '';
  const selfUid = info?.uid ?? '';
  console.log(`[profile] pid=${pid} uin=${selfUin} uid=${selfUid} loggedIn=${info?.loggedIn}`);
  if (!selfUin) throw new Error('probe 没拿到 uin');

  console.log(`\n[profile] 注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[profile] 注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  const targetUin = Number(TARGET_ARG ?? selfUin);

  console.log(`\n[profile] ===== 0xFE1_2 资料 (uin=${targetUin}) =====`);
  const profile = await FetchUserProfile.invoke(nt, pid, { uin: targetUin });
  console.dir(profile, { depth: null });
  console.log(`[profile] >>> QQ 等级: ${profile.level}`);

  const targetUid = TARGET_ARG ? profile.uid : selfUid || SELF_UID;
  if (!targetUid) throw new Error('拿不到目标 uid,无法查点赞数');

  console.log(`\n[profile] ===== 0x7ED_12 点赞 (uid=${targetUid}) =====`);
  const like = await GetProfileLike.invoke(nt, pid, { targetUid });
  console.dir(like, { depth: null });
  console.log(`[profile] >>> 累计获赞: ${like.voteInfo.totalCount}  今日: ${like.voteInfo.todayCount}`);
  console.log(`[profile] >>> 收藏数: ${like.favoriteInfo.totalCount}`);
}

main().catch((e) => {
  console.error('[profile] 失败:', e);
  process.exit(1);
});
