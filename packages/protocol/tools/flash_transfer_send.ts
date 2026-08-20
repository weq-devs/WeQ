/**
 * 端到端发送:把已上传的闪传 fileset 分享给私聊 uid 或群聊。
 *
 * 用 @weq/protocol 的 SendFlashMsg(OIDB 0x93d7_1)。fileset_uuid 和 target 都由外部
 * 传入,不做任何解析/转换。0x93d7 响应无 message_id(分享 fileset,非传统消息)。
 *
 * 用法:
 *   pnpm --filter @weq/protocol tools:flash-transfer-send --fileset-uuid <uuid> --uid u_xxx
 *   pnpm --filter @weq/protocol tools:flash-transfer-send --fileset-uuid <uuid> --group-id 123456
 *   pnpm tsx packages/protocol/tools/flash_transfer_send.ts --fileset-uuid <uuid> --group-id 123456
 *
 * linux 需 root(ptrace 注入):
 *   sudo -E node --import tsx packages/protocol/tools/flash_transfer_send.ts --fileset-uuid <uuid> --uid u_xxx
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { SendFlashMsg } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(`[flash-send] 失败: ${msg}`);
  process.exit(1);
}

const FILESET_UUID = opt('--fileset-uuid') ?? fail('必须传 --fileset-uuid <fileset_uuid>');
const GROUP_ID_ARG = opt('--group-id');
const UID_ARG = opt('--uid');
if (!GROUP_ID_ARG && !UID_ARG) fail('必须传 --group-id 或 --uid 之一');

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
  console.log(`[flash-send] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[flash-send] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'flash-send' });

  const groupId = GROUP_ID_ARG !== undefined ? Number(GROUP_ID_ARG) : undefined;
  if (groupId !== undefined && !Number.isSafeInteger(groupId))
    fail(`非法 --group-id: ${GROUP_ID_ARG}`);
  await SendFlashMsg.invoke(nt, pid, {
    filesetUuid: FILESET_UUID,
    groupId,
    targetUid: UID_ARG,
  });

  console.log('\n════════ 闪传发送结果 ════════');
  console.log(`  fileset_uuid: ${FILESET_UUID}`);
  console.log(
    `  target:       ${groupId !== undefined ? `group_id=${groupId}` : `uid=${UID_ARG}`}`,
  );
  console.log('  已发送(0x93d7 无 message_id,仅确认送达)。');
}

main().catch((e) => {
  console.error('[flash-send] 失败:', e);
  process.exit(1);
});
