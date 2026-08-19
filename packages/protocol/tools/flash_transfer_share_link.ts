/**
 * 端到端:用 fileset_uuid 换取闪传分享链接。
 *
 * 用 @weq/protocol 的 GetFilesetDetail(OIDB 0x93d3_1),分享链接是
 * https://qfile.qq.com/q/<code>。uuid 由外部传入,不做解析。
 *
 * 用法:
 *   pnpm --filter @weq/protocol tools:flash-transfer-share-link --fileset-uuid <uuid>
 *   pnpm tsx packages/protocol/tools/flash_transfer_share_link.ts --fileset-uuid <uuid>
 *
 * linux 需 root(ptrace 注入):
 *   sudo -E node --import tsx packages/protocol/tools/flash_transfer_share_link.ts --fileset-uuid <uuid>
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { GetFilesetDetail } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(`[flash-share] 失败: ${msg}`);
  process.exit(1);
}

const FILESET_UUID = opt('--fileset-uuid') ?? fail('必须传 --fileset-uuid <fileset_uuid>');

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
  console.log(`[flash-share] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[flash-share] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'flash-share' });

  const entries = await GetFilesetDetail.invoke(nt, pid, { filesetUuid: FILESET_UUID });
  const shareUrl = entries.find((entry) => entry.shareUrl !== '')?.shareUrl ?? '';

  console.log('\n════════ 闪传分享链接 ════════');
  console.log(`  fileset_uuid: ${FILESET_UUID}`);
  console.log(`  share_link:   ${shareUrl || '(无)'}`);
}

main().catch((e) => {
  console.error('[flash-share] 失败:', e);
  process.exit(1);
});
