/**
 * 端到端发送:向私聊 QQ 号或群聊发送自定义图文 (URL-share) Ark 卡片。
 *
 * 用 @weq/protocol 的 SendTuwenArk(OIDB 0xdc2_34)。--user-id 传 QQ 号(C2C),
 * --group-id 传群号;targetId 与 peerType 由工具换算,不做额外解析。
 * 0xdc2_34 响应仅 ack,无 message_id(不可撤回/设精华)。
 *
 * 用法:
 *   pnpm --filter @weq/protocol tools:send-tuwen-ark --group-id 123456 \
 *     --title '标题' --desc '描述' --jump-url 'https://example.com'
 *   pnpm --filter @weq/protocol tools:send-tuwen-ark --user-id 10001 \
 *     --title '标题' --desc '描述' --jump-url 'https://example.com' --summary '[分享]'
 *   pnpm tsx packages/protocol/tools/send_tuwen_ark.ts --group-id 123456 \
 *     --title '标题' --desc '描述' --jump-url 'https://example.com'
 *
 * linux 需 root(ptrace 注入):
 *   sudo -E node --import tsx packages/protocol/tools/send_tuwen_ark.ts --group-id 123456 ...
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { SendTuwenArk } from '../src/index';

const DEFAULT_PREVIEW_URL =
  'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(`[tuwen-ark] 失败: ${msg}`);
  process.exit(1);
}

const TITLE = opt('--title') ?? fail('必须传 --title <卡片标题>');
const DESC = opt('--desc') ?? fail('必须传 --desc <卡片描述>');
const JUMP_URL = opt('--jump-url') ?? fail('必须传 --jump-url <跳转链接>');
const SUMMARY = opt('--summary') ?? '[分享]';
const PREVIEW_URL = opt('--preview-url') ?? DEFAULT_PREVIEW_URL;

const GROUP_ID_ARG = opt('--group-id');
const USER_ID_ARG = opt('--user-id');
if (!GROUP_ID_ARG && !USER_ID_ARG) fail('必须传 --group-id 或 --user-id 之一');

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
  console.log(`[tuwen-ark] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[tuwen-ark] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'tuwen-ark' });

  const groupId = GROUP_ID_ARG !== undefined ? Number(GROUP_ID_ARG) : undefined;
  if (groupId !== undefined && !Number.isSafeInteger(groupId))
    fail(`非法 --group-id: ${GROUP_ID_ARG}`);
  const userId = USER_ID_ARG !== undefined ? Number(USER_ID_ARG) : undefined;
  if (userId !== undefined && !Number.isSafeInteger(userId))
    fail(`非法 --user-id: ${USER_ID_ARG}`);

  await SendTuwenArk.invoke(nt, pid, {
    targetId: groupId ?? userId!,
    peerType: groupId !== undefined ? 1 : 0,
    title: TITLE,
    desc: DESC,
    summary: SUMMARY,
    jumpUrl: JUMP_URL,
    previewUrl: PREVIEW_URL,
  });

  console.log('\n════════ 图文 Ark 发送结果 ════════');
  console.log(`  target:  ${groupId !== undefined ? `group_id=${groupId}` : `user_id=${userId}`}`);
  console.log(`  title:   ${TITLE}`);
  console.log(`  jump:    ${JUMP_URL}`);
  console.log('  已发送(0xdc2_34 仅 ack,无 message_id)。');
}

main().catch((e) => {
  console.error('[tuwen-ark] 失败:', e);
  process.exit(1);
});
