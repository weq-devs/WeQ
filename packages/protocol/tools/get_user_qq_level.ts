/**
 * 端到端探测:用 `@weq/protocol` 的 GetUserQqLevel (OIDB 0xFE1_2) 查询 QQ 等级。
 *
 * 需要目标账号的 QQ 正在运行且已登录;脚本会注入 hook 后发 OIDB 包。
 * 只请求 property key 105,响应只解析 QQ 等级(服务端在该 uin-form 查询下不回显 uid)。
 *
 * 用法:
 *   pnpm --filter @weq/protocol tools:get-user-qq-level                # 不传 --uin 时查登录账号自己
 *   pnpm --filter @weq/protocol tools:get-user-qq-level --uin 876857561 # 查指定 QQ 号
 *   pnpm tsx packages/protocol/tools/get_user_qq_level.ts --uin 876857561
 *
 * linux 需 root(ptrace 注入):
 *   sudo -E node --import tsx packages/protocol/tools/get_user_qq_level.ts --uin 876857561
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { GetUserQqLevel } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const UIN_ARG = opt('--uin');

type Nt = ReturnType<typeof loadNative>['ntHelper'];

function probeSafe(nt: Nt, pid: number): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch {
    return null;
  }
}

function parseUin(raw: string): number {
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`非法 --uin: ${raw}`);
  return v;
}

/** 选一个已登录的 QQ 进程,并返回它的登录 uin(注入 hook 需要用登录账号,不是查询目标)。 */
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

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const { pid, loginUin } = await resolveTarget(nt);
  console.log(`[level] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[level] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'level' });

  const targetUin = UIN_ARG !== undefined ? parseUin(UIN_ARG) : Number(loginUin);
  console.log(
    `[level] 查询 0xFE1_2 QQ 等级 (uin=${targetUin})` +
      (UIN_ARG === undefined ? '(未传 --uin,默认查自己)' : ''),
  );

  const info = await GetUserQqLevel.invoke(nt, pid, { uin: targetUin });

  console.log('\n════════ 0xFE1_2 QQ 等级 ════════');
  console.log(`  QQ 号:   ${info.uin}`);
  console.log(`  QQ 等级: ${info.level}`);
}

main().catch((e) => {
  console.error('[level] 失败:', e);
  process.exit(1);
});
