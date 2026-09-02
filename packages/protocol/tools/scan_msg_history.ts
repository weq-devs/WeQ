/**
 * 批量扫描并解析历史消息，验证解码器对真实消息没有报错。
 *
 * 用法：
 *   pnpm --filter @weq/protocol tools:scan-msg-history --kind group --id 673646675 --start 1361 --end 1560
 *   pnpm --filter @weq/protocol tools:scan-msg-history --kind c2c --id u_xxx --start 1 --end 100
 *
 * 输出：
 *   1. 分页拉取（每窗 30 条）窗口 / 返回条数
 *   2. 每条 decodeMessage 的成功/失败统计 + 元素 kind 分布
 *   3. 失败时打印 seq + 错误 + 该消息的原始 tag:value JSON
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import {
  extractPath,
  fetchC2cHistoryRaw,
  fetchGroupHistoryRaw,
  protoToJson,
  type PathStep,
} from '../src/index';
import { decodeMessage } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(`[scan] 失败: ${msg}`);
  process.exit(1);
}

const KIND = opt('--kind') ?? fail('必须传 --kind <group|c2c>');
if (KIND !== 'group' && KIND !== 'c2c') fail(`--kind 只能是 group 或 c2c，收到 ${KIND}`);
const ID = opt('--id') ?? fail('必须传 --id <群号|uid>');
const START = Number(opt('--start') ?? fail('必须传 --start <seq>'));
const END = Number(opt('--end') ?? fail('必须传 --end <seq>'));
if (!Number.isSafeInteger(START) || !Number.isSafeInteger(END) || START > END || END < 0) {
  fail(`seq 窗口非法: ${START}-${END}`);
}

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

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const { pid, loginUin } = await resolveTarget(nt);
  console.log(`[scan] pid=${pid} 登录账号=${loginUin}`);

  console.log(`[scan] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, loginUin, { label: 'scan' });

  // 服务端单次最多返回约 30 条，按 30 宽窗口分页拉取再合并。
  const WINDOW = 30;
  const batches: { rawResponse: Uint8Array; messages: Record<string, unknown>[] }[] = [];
  for (let s = START; s <= END; s += WINDOW) {
    const e = Math.min(s + WINDOW - 1, END);
    const res =
      KIND === 'group'
        ? await fetchGroupHistoryRaw(nt, pid, { groupUin: Number(ID), startSeq: s, endSeq: e })
        : await fetchC2cHistoryRaw(nt, pid, { friendUid: ID, startSeq: s, endSeq: e });
    batches.push({ rawResponse: res.rawResponse, messages: res.messages });
    console.log(`[scan] 窗口 ${s}-${e} 返回 ${res.messages.length} 条`);
  }

  const total = batches.reduce((n, b) => n + b.messages.length, 0);
  console.log(`[scan] 拉取 ${START}-${END}，共返回 ${total} 条`);

  const kindCount = new Map<string, number>();
  let ok = 0;
  const seenSeqs = new Set<number>();
  const errors: { seq: number; error: string; raw: string }[] = [];

  for (const batch of batches) {
    batch.messages.forEach((msg, index) => {
      const seq = Number(
        (msg.contentHead as { sequence?: unknown } | undefined)?.sequence ?? index,
      );
      if (seenSeqs.has(seq)) return;
      seenSeqs.add(seq);
      const steps: PathStep[] =
        KIND === 'group' ? [{ tag: 3 }, { tag: 6, index }] : [{ tag: 7, index }];
      const raw = extractPath(batch.rawResponse, steps);
      if (!raw) {
        errors.push({ seq, error: 'extractPath 无法从响应中抠出该消息原始字节', raw: '' });
        return;
      }
      try {
        const decoded = decodeMessage(raw);
        ok += 1;
        for (const el of decoded.elements) {
          const kind =
            typeof (el as { kind?: unknown }).kind === 'string'
              ? (el as { kind: string }).kind
              : '(raw)';
          kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
        }
      } catch (e) {
        errors.push({
          seq,
          error: e instanceof Error ? e.message : String(e),
          raw: JSON.stringify(protoToJson(raw), null, 2),
        });
      }
    });
  }

  console.log(`[scan] 解析成功 ${ok}/${total}，失败 ${errors.length}`);
  if (kindCount.size > 0) {
    const kinds = [...kindCount.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[scan] 元素分布: ${kinds.map(([k, n]) => `${k}=${n}`).join(' ')}`);
  }

  for (const err of errors) {
    console.log(`\n[scan] ✗ seq=${err.seq}: ${err.error}`);
    if (err.raw) console.log(err.raw);
  }

  if (errors.length > 0) {
    console.error(`\n[scan] 共 ${errors.length} 条解析失败`);
    process.exitCode = 1;
  } else {
    console.log('\n[scan] 全部解析通过 🎉');
  }
}

main().catch((e) => {
  console.error('[scan] 失败:', e);
  process.exit(1);
});
