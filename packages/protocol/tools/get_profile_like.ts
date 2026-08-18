/**
 * 端到端探测:用 `@weq/protocol` 的 GetProfileLike (OIDB 0x7ED_12) 查询资料卡赞/收藏数。
 *
 * 需要目标账号的 QQ 正在运行且已登录;脚本会注入 hook 后发 OIDB 包。
 * 0x7ED_12 按 uid 查询,必须传 --uid(0xFE1_2 不回显 uid,无法用 uin 反查)。
 *
 * 用法:
 *   pnpm --filter @weq/protocol tools:get-profile-like --uid u_mGI...
 *   pnpm tsx packages/protocol/tools/get_profile_like.ts --uid u_mGI...
 *
 * linux 需 root(ptrace 注入):
 *   sudo -E node --import tsx packages/protocol/tools/get_profile_like.ts --uid u_mGI...
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { GetProfileLike, type InteractionCounts } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(`[like] 失败: ${msg}`);
  process.exit(1);
}

const UID_ARG = opt('--uid') ?? fail('必须传 --uid <目标uid>');

type Nt = ReturnType<typeof loadNative>['ntHelper'];

function probeSafe(nt: Nt, pid: number): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch {
    return null;
  }
}

/** 选一个已登录的 QQ 进程,并返回它的登录 uin(注入 hook 需要用登录账号)。 */
async function resolveTarget(nt: Nt): Promise<{ pid: number; loginUin: string }> {
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');

  // .env 里配了 WEQ_TEST_UIN 时用它来匹配登录账号;没配则退化为按 loggedIn 挑选。
  let wantUin = '';
  try {
    wantUin = testEnv.uin;
  } catch {
    // 未配置 .env,忽略。
  }

  let pid = pids[0]!;
  if (pids.length > 1) {
    const candidates = pids.map((p) => ({ pid: p, info: probeSafe(nt, p) }));
    const hit = wantUin
      ? candidates.find((c) => c.info?.uin === wantUin && c.info.loggedIn)
      : candidates.find((c) => c.info?.loggedIn);
    if (!hit) {
      throw new Error(
        `多个 QQ 进程且无法确定登录账号:${pids.join(', ')}` +
          (wantUin
            ? `(没有 uin=${wantUin} 且已登录的进程)`
            : '(可用 .env 配置 WEQ_TEST_UIN 来指定)'),
      );
    }
    pid = hit.pid;
  }

  const info = probeSafe(nt, pid);
  const loginUin = wantUin || info?.uin || '';
  if (!loginUin) throw new Error(`探测不到 pid=${pid} 的登录 uin`);
  return { pid, loginUin };
}

function fmtTime(sec: number): string {
  return sec > 0 ? new Date(sec * 1000).toLocaleString() : '无';
}

function printCounts(label: string, c: InteractionCounts): void {
  console.log(`  ${label}:`);
  console.log(`    累计: ${c.totalCount}   今日: ${c.todayCount}   新增: ${c.newCount}`);
  console.log(`    最近: ${fmtTime(c.lastTime)}`);
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const { pid, loginUin } = await resolveTarget(nt);
  console.log(`[like] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[like] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'like' });

  console.log(`[like] 查询 0x7ED_12 点赞/收藏 (--uid ${UID_ARG})`);
  const like = await GetProfileLike.invoke(nt, pid, { targetUid: UID_ARG });

  console.log('\n════════ 0x7ED_12 资料卡赞/收藏 ════════');
  console.log(`  UID:        ${like.uid}`);
  printCounts('点赞 voteInfo', like.voteInfo);
  printCounts('收藏 favoriteInfo', like.favoriteInfo);
}

main().catch((e) => {
  console.error('[like] 失败:', e);
  process.exit(1);
});
