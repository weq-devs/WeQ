/**
 * 获取合并转发消息内容探查工具 —— trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg。
 *
 * 打印：
 *   1. 原始响应长度 / 压缩 payload 长度 / 解压后 LongMsgResult 长度 + action 数 + 消息数；
 *   2. 指定转发消息（默认第一条）的原始 hex；
 *   3. 该消息的原始 tag:value 树 + 解码后的简化 msg JSON（head / sender / session /
 *      elements / dress）。
 *
 * 用法：
 *   pnpm --filter @weq/protocol tools:fetch-forward --res-id <resId> [--uid <自己uid>]
 *   pnpm tsx packages/protocol/tools/fetch_forward.ts --res-id <resId> [--uid <自己uid>]
 *
 * 可选参数：
 *   --uid <uid>      自己账号的长 uid（缺省依次回退 WEQ_TEST_UID / QQ 进程探测）
 *   --index N        打印第 N 条转发消息（默认 0 = 第一条）
 *   --no-hex         不打印消息原始 hex
 *   --no-json        不打印解码 msg JSON
 *   --no-raw-json    不打印原始 tag:value 树
 *   --resp-hex       额外打印整个响应（RecvLongMsgResp）的 hex
 *   --resp-json      额外打印整个响应的 tag:value JSON
 *   --payload-hex    额外打印压缩 payload 的 hex
 *   --inflated-hex   额外打印 gunzip 解压后 LongMsgResult 的 hex
 *   --longmsg-json   额外打印解压后 LongMsgResult 的 tag:value JSON
 *
 * linux 需要 root(ptrace 注入)：
 *   sudo -E node --import tsx packages/protocol/tools/fetch_forward.ts --res-id ...
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { bytesToHex, protoToJson, extractPath, decodeMessage, fetchForwardRaw } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (flag: string): boolean => argv.includes(flag);

function fail(msg: string): never {
  console.error(`[forward] 失败: ${msg}`);
  process.exit(1);
}

const RES_ID = opt('--res-id') ?? fail('必须传 --res-id <合并转发resId>');
if (!RES_ID.trim()) fail('--res-id 不能为空');
const UID_ARG = opt('--uid') ?? '';
const MSG_INDEX = Number(opt('--index') ?? '0');
if (!Number.isSafeInteger(MSG_INDEX) || MSG_INDEX < 0) fail(`--index 非法: ${String(MSG_INDEX)}`);
const SHOW_HEX = !has('--no-hex');
const SHOW_JSON = !has('--no-json');
const SHOW_RESP_HEX = has('--resp-hex');
const SHOW_RESP_JSON = has('--resp-json');
const SHOW_PAYLOAD_HEX = has('--payload-hex');
const SHOW_INFLATED_HEX = has('--inflated-hex');
const SHOW_LONGMSG_JSON = has('--longmsg-json');
const SHOW_RAW_JSON = !has('--no-raw-json');

type Nt = ReturnType<typeof loadNative>['ntHelper'];

function probeSafe(nt: Nt, pid: number): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch {
    return null;
  }
}

/** 选一个已登录的 QQ 进程，并返回它的登录 uin（注入 hook 需要登录账号）+ 探测到的 uid。 */
async function resolveTarget(
  nt: Nt,
): Promise<{ pid: number; loginUin: string; probeUid: string | null }> {
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe，请先打开并登录目标账号');

  let wantUin = '';
  try {
    wantUin = testEnv.uin;
  } catch {
    // 未配置 .env，忽略。
  }

  let pid = pids[0]!;
  if (pids.length > 1) {
    const candidates = pids.map((p) => ({ pid: p, info: probeSafe(nt, p) }));
    const hit = wantUin
      ? candidates.find((c) => c.info?.uin === wantUin && c.info.loggedIn)
      : candidates.find((c) => c.info?.loggedIn);
    if (!hit) {
      throw new Error(
        `多个 QQ 进程且无法确定登录账号: ${pids.join(', ')}` +
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
  return { pid, loginUin, probeUid: info?.uid ?? null };
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  return value;
};

function printJson(label: string, bytes: Uint8Array): void {
  console.log(`\n──── ${label} ────`);
  console.log(JSON.stringify(protoToJson(bytes), null, 2));
}

function printDecoded(label: string, msg: ReturnType<typeof decodeMessage>): void {
  console.log(`\n──── ${label} ────`);
  console.log(JSON.stringify(msg, jsonReplacer, 2));
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const { pid, loginUin, probeUid } = await resolveTarget(nt);
  console.log(`[forward] pid=${pid} 登录账号=${loginUin}`);

  const selfUid = UID_ARG || testEnv.uid || probeUid || '';
  if (!selfUid) {
    fail('拿不到自己账号的长 uid：请用 --uid <uid> 传入，或配置 WEQ_TEST_UID');
  }

  console.log(`[forward] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'forward' });

  console.log(`[forward] 拉取合并转发 --res-id ${RES_ID} (selfUid=${selfUid})`);
  const res = await fetchForwardRaw(nt, pid, { selfUid, resId: RES_ID });

  console.log('\n════════════════════ 响应概览 ════════════════════');
  console.log(`  命令:        ${res.cmd}`);
  console.log(`  resId:       ${res.resId}`);
  console.log(`  selfUid:     ${selfUid}`);
  console.log(`  响应长度:    ${res.rawResponse.length} 字节`);
  console.log(`  压缩 payload: ${res.payload?.length ?? 0} 字节`);
  console.log(`  解压后长度:  ${res.inflated?.length ?? 0} 字节`);
  console.log(`  action 数:   ${res.actions.length}（含 'MultiMsg' 与内层 uuid 条目）`);
  console.log(
    `  消息数量:    ${res.messages.length} (可用 --index 0..${Math.max(0, res.messages.length - 1)})`,
  );
  if (res.error) console.log(`  错误:        ${res.error}`);

  if (SHOW_RESP_HEX) {
    console.log('\n──── 完整响应 hex ────');
    console.log(bytesToHex(res.rawResponse));
  }
  if (SHOW_RESP_JSON) printJson('完整响应 tag:value JSON', res.rawResponse);
  if (SHOW_PAYLOAD_HEX && res.payload) {
    console.log('\n──── 压缩 payload hex ────');
    console.log(bytesToHex(res.payload));
  }
  if (SHOW_INFLATED_HEX && res.inflated) {
    console.log('\n──── 解压 LongMsgResult hex ────');
    console.log(bytesToHex(res.inflated));
  }
  if (SHOW_LONGMSG_JSON && res.inflated) {
    printJson('解压 LongMsgResult tag:value JSON', res.inflated);
  }

  if (res.messages.length === 0) {
    console.log('\n[forward] 该 resId 没有解出任何转发消息（可能 resId 过期 / 不是合并转发）');
    return;
  }

  const index = Math.min(MSG_INDEX, res.messages.length - 1);
  const multiMsgIndex = res.actions.findIndex(
    (a) => (a as { actionCommand?: string }).actionCommand === 'MultiMsg',
  );
  const msgBytes =
    res.inflated && multiMsgIndex >= 0
      ? extractPath(res.inflated, [{ tag: 2, index: multiMsgIndex }, { tag: 2 }, { tag: 1, index }])
      : null;

  console.log('\n════════════════════ 第 ' + index + ' 条转发消息 ════════════════════');
  if (!msgBytes) {
    console.log('[forward] 无法从 LongMsgResult 中抠出该消息的原始字节（extractPath 失败）');
    console.log('  已按 schema 解码的 msgBody 见上方 --longmsg-json / --resp-json 输出。');
  } else {
    console.log(`  原始长度:    ${msgBytes.length} 字节`);
    if (SHOW_HEX) {
      console.log('\n──── 原始 hex ────');
      console.log(bytesToHex(msgBytes));
    }
    if (SHOW_RAW_JSON) printJson('原始 tag:value JSON', msgBytes);
    if (SHOW_JSON) printDecoded('解码 msg JSON（含 dress）', decodeMessage(msgBytes));
  }
}

main().catch((e) => {
  console.error('[forward] 失败:', e);
  process.exit(1);
});
