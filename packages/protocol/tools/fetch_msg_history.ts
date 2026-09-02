/**
 * 主动拉取历史消息探查工具 —— SsoGetGroupMsg / SsoGetC2cMsg（按 seq 范围）。
 *
 * 打印：
 *   1. 原始响应长度 + 顶层字段 + 消息数量；
 *   2. 指定消息（默认第一条）的原始 hex；
 *   3. 该消息的原始 tag:value 树 + 解码后的简化 msg JSON（head / sender / session / elements / dress）。
 *
 * 用法：
 *   pnpm --filter @weq/protocol tools:fetch-msg-history --kind group --id 123456789 --start 100 --end 110
 *   pnpm --filter @weq/protocol tools:fetch-msg-history --kind c2c --id u_mGI... --start 100 --end 110
 *   pnpm tsx packages/protocol/tools/fetch_msg_history.ts --kind group --id ... --start ... --end ...
 *
 * 可选参数：
 *   --index N       打印第 N 条消息（默认 0 = 第一条）
 *   --no-hex        不打印消息原始 hex
 *   --no-json       不打印解码 msg JSON
 *   --no-raw-json   不打印原始 tag:value 树
 *   --resp-hex      额外打印整个响应的 hex
 *   --resp-json     额外打印整个响应的 tag:value JSON
 *
 * linux 需要 root(ptrace 注入)：
 *   sudo -E node --import tsx packages/protocol/tools/fetch_msg_history.ts ...
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import {
  bytesToHex,
  protoToJson,
  extractPath,
  fetchC2cHistoryRaw,
  fetchGroupHistoryRaw,
  type PathStep,
} from '../src/index';
import { decodeMessage } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (flag: string): boolean => argv.includes(flag);

function fail(msg: string): never {
  console.error(`[history] 失败: ${msg}`);
  process.exit(1);
}

const KIND = opt('--kind') ?? fail('必须传 --kind <group|c2c>');
if (KIND !== 'group' && KIND !== 'c2c') fail(`--kind 只能是 group 或 c2c，收到: ${KIND}`);
const ID = opt('--id') ?? fail('必须传 --id <群号|uid>');
const START_RAW = opt('--start') ?? fail('必须传 --start <seq>');
const END_RAW = opt('--end') ?? fail('必须传 --end <seq>');
const START = Number(START_RAW);
const END = Number(END_RAW);
if (!Number.isSafeInteger(START) || !Number.isSafeInteger(END) || START > END || END < 0) {
  fail(`seq 窗口非法: ${START_RAW}-${END_RAW}`);
}
const MSG_INDEX = Number(opt('--index') ?? '0');
if (!Number.isSafeInteger(MSG_INDEX) || MSG_INDEX < 0) fail(`--index 非法: ${String(MSG_INDEX)}`);
const SHOW_HEX = !has('--no-hex');
const SHOW_JSON = !has('--no-json');
const SHOW_RESP_HEX = has('--resp-hex');
const SHOW_RESP_JSON = has('--resp-json');
const SHOW_RAW_JSON = !has('--no-raw-json');

type Nt = ReturnType<typeof loadNative>['ntHelper'];

function probeSafe(nt: Nt, pid: number): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch {
    return null;
  }
}

/** 选一个已登录的 QQ 进程，并返回它的登录 uin（注入 hook 需要登录账号）。 */
async function resolveTarget(nt: Nt): Promise<{ pid: number; loginUin: string }> {
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
  return { pid, loginUin };
}

function printJson(label: string, bytes: Uint8Array): void {
  console.log(`\n──── ${label} ────`);
  console.log(JSON.stringify(protoToJson(bytes), null, 2));
}

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  return value;
};

function printDecoded(label: string, msg: ReturnType<typeof decodeMessage>): void {
  console.log(`\n──── ${label} ────`);
  console.log(JSON.stringify(msg, jsonReplacer, 2));
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const { pid, loginUin } = await resolveTarget(nt);
  console.log(`[history] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[history] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'history' });

  const range = { startSeq: START, endSeq: END };
  const res =
    KIND === 'group'
      ? await fetchGroupHistoryRaw(nt, pid, { groupUin: Number(ID), ...range })
      : await fetchC2cHistoryRaw(nt, pid, { friendUid: ID, ...range });

  console.log('\n════════════════════ 响应概览 ════════════════════');
  console.log(`  命令:        ${res.cmd}`);
  console.log(
    `  请求窗口:    seq ${res.range.startSeq} - ${res.range.endSeq}${KIND === 'c2c' ? ' (会话级 NT sequence)' : ''}`,
  );
  if (res.peer.groupUin) console.log(`  会话:        groupUin=${res.peer.groupUin}`);
  if (res.peer.friendUid) console.log(`  会话:        friendUid=${res.peer.friendUid}`);
  console.log(`  响应长度:    ${res.rawResponse.length} 字节`);
  console.log(
    `  消息数量:    ${res.messages.length} (可用 --index 0..${Math.max(0, res.messages.length - 1)})`,
  );

  if (SHOW_RESP_HEX) {
    console.log('\n──── 完整响应 hex ────');
    console.log(bytesToHex(res.rawResponse));
  }
  if (SHOW_RESP_JSON) printJson('完整响应 tag:value JSON', res.rawResponse);

  if (res.messages.length === 0) {
    console.log('\n[history] 该窗口没有返回任何消息');
    return;
  }

  const index = Math.min(MSG_INDEX, res.messages.length - 1);
  const steps: PathStep[] =
    KIND === 'group' ? [{ tag: 3 }, { tag: 6, index }] : [{ tag: 7, index }];
  const msgBytes = extractPath(res.rawResponse, steps);

  console.log('\n════════════════════ 第 ' + index + ' 条消息 ════════════════════');
  if (!msgBytes) {
    console.log('[history] 无法从响应中抠出该消息的原始字节（extractPath 失败）');
  } else {
    console.log(`  原始长度:    ${msgBytes.length} 字节`);
    if (SHOW_HEX) {
      console.log('\n──── 原始 hex ────');
      console.log(bytesToHex(msgBytes));
    }
    if (SHOW_RAW_JSON) printJson('原始 tag:value JSON', msgBytes);
    if (SHOW_JSON) printDecoded('解码 msg JSON', decodeMessage(msgBytes));
  }
  console.log(
    `\n[history] 消息序号提示: 群聊用群内 seq，私聊用会话级 NT seq${KIND === 'c2c' ? '（不是发送者本地 clientSeq）' : ''}`,
  );
}

main().catch((e) => {
  console.error('[history] 失败:', e);
  process.exit(1);
});
