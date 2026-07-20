/**
 * Raw probe for the Weiyun collector.fcg 收藏 network path.
 *
 * Injects into the live QQ, fetches the weiyun.com p_skey, fires ONE collector
 * request and dumps the raw response verbatim — status, headers, byte length,
 * hex, and a text interpretation. Use this to diagnose "collection response is
 * too short" (which means we got <=16 bytes, i.e. not a binary envelope at all).
 *
 * Run:  pnpm tsx ./packages/service/test/collection_network_probe.ts [uin]
 */

import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ProtoMsg } from '@weq/codec';
import { decodeMessage } from '@weq/db';
import {
  CollectorReqHead,
  CollectorReqBody,
  CollectorRespHead,
  CollectorRespBody,
} from '@weq/codec/proto/collection/index';
import { testEnv } from '@weq/testkit';

const TARGET_UIN = process.argv[2] ?? testEnv.uin;

const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const HOST = 'collector.weiyun.com';
const TICKET_TYPE = 27;
const APP_ID = 5_004;
const OPERATION_ID = 20_000;
const PAGE_SIZE = 50;
const CLIENT_VERSION = 0x6105f5e164fn;
const INITIAL_TIMESTAMP = 0xffff_ffff_ffff_ffffn;
const MAGIC = Uint8Array.from([0x20, 0x13, 0x03, 0x29]);
const VERSION = Uint8Array.from([0x00, 0x01]);

function encodeEnvelope(head: Uint8Array, body: Uint8Array): Uint8Array {
  const total = 16 + head.length + body.length;
  const out = Buffer.allocUnsafe(total);
  out.set(MAGIC, 0);
  out.set(VERSION, 4);
  out.writeUInt32BE(total, 6);
  out.writeUInt32BE(body.length, 10);
  out.writeUInt16BE(0, 14);
  out.set(head, 16);
  out.set(body, 16 + head.length);
  return out;
}

function buildRequest(uin: bigint, pskey: string): Uint8Array {
  const head = new ProtoMsg(CollectorReqHead).encode({
    uin,
    sequence: 1,
    commandType: 1,
    operationId: OPERATION_ID,
    clientVersion: CLIENT_VERSION,
    platform: 4,
    ticketType: TICKET_TYPE,
    ticket: pskey,
    field14: 8,
    field15: 9,
  });
  // 只发非零字段(collector 严格:零值字段会被判 190013 缺参数)。
  const body = new ProtoMsg(CollectorReqBody).encode({
    operation: {
      getCollectionList: {
        timeStamp: INITIAL_TIMESTAMP,
        orderType: 2,
        count: PAGE_SIZE,
        searchDown: 1,
      },
    },
  });
  return encodeEnvelope(head, body);
}

function probeSafe(
  nt: ReturnType<typeof loadNative>['ntHelper'],
  pid: number,
): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch (e) {
    console.warn(`probeQqLoginInfo(${pid}) 抛错:`, e);
    return null;
  }
}

async function pickPid(nt: ReturnType<typeof loadNative>['ntHelper']): Promise<number> {
  const pids = nt.getQqProcesses();
  console.log(`运行中的 QQ 进程 pid: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');

  const probes = pids.map((pid) => ({ pid, info: probeSafe(nt, pid) }));
  for (const { pid, info } of probes) {
    console.log(`  pid=${pid}  uin=${info?.uin || '?'}  loggedIn=${info?.loggedIn ?? '?'}`);
  }

  if (pids.length === 1 && pids[0] !== undefined) return pids[0];
  const match = probes.find((p) => p.info?.uin === TARGET_UIN && p.info?.loggedIn)?.pid;
  if (match === undefined) {
    throw new Error(`多个 QQ 进程,没找到 uin=${TARGET_UIN} 且已登录的进程`);
  }
  return match;
}

function dumpBytes(label: string, bytes: Uint8Array): void {
  const buf = Buffer.from(bytes);
  console.log(`\n=== ${label} ===`);
  console.log(`字节数: ${buf.length}`);
  console.log(`hex (前 256B): ${buf.subarray(0, 256).toString('hex')}`);
  console.log(`--- 当作 UTF-8 文本 (前 1000 字符) ---`);
  console.log(buf.subarray(0, 1000).toString('utf8'));
  // envelope 头解析尝试
  if (buf.length >= 16) {
    const magicOk = buf.subarray(0, 4).equals(Buffer.from(MAGIC));
    const versionOk = buf.subarray(4, 6).equals(Buffer.from(VERSION));
    console.log(`--- envelope 头 ---`);
    console.log(`magic ok: ${magicOk} (${buf.subarray(0, 4).toString('hex')})`);
    console.log(`version ok: ${versionOk} (${buf.subarray(4, 6).toString('hex')})`);
    console.log(`totalLength(6): ${buf.readUInt32BE(6)}  实际: ${buf.length}`);
    console.log(`bodyLength(10): ${buf.readUInt32BE(10)}`);
    console.log(`reserved(14): ${buf.readUInt16BE(14)}`);
  } else {
    console.log(`(不足 16 字节,不可能是 envelope)`);
  }
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const pid = await pickPid(nt);

  console.log(`\n注入 hook 到 pid=${pid} ...`);
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`注入结果: pid=${status.pid} uin=${status.uin} loggedIn=${status.loggedIn}`);

  console.log(`\n获取 weiyun.com p_skey ...`);
  const pskey = await nt.fetchPskey(pid, TARGET_UIN, 'weiyun.com');
  console.log(`p_skey (raw): "${pskey}"`);
  console.log(`p_skey 长度: ${pskey.length}`);
  if (!pskey) {
    console.error('!! p_skey 为空 —— collector 会拒绝,先解决凭据问题');
  }

  const reqBytes = buildRequest(BigInt(TARGET_UIN), pskey);
  dumpBytes('请求报文 (发出去的)', reqBytes);

  const cookie = `uin=${TARGET_UIN};vt=${TICKET_TYPE};vi=${pskey};appid=${APP_ID}`;
  console.log(`\nCookie: ${cookie.slice(0, 40)}...(vi 省略)`);

  console.log(`\nPOST ${ENDPOINT} ...`);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Cookie: cookie,
      Host: HOST,
      Range: 'bytes=0-',
    },
    body: Buffer.from(reqBytes),
  });

  console.log(`\n=== HTTP 响应 ===`);
  console.log(`status: ${res.status} ${res.statusText}`);
  console.log(`headers:`);
  res.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));

  const respBytes = new Uint8Array(await res.arrayBuffer());
  dumpBytes('响应报文 (收到的)', respBytes);

  // 用 lenient assembler 解 envelope(免疫尾部填充,不像 strict protobuf 会崩)。
  if (respBytes.length > 16) {
    try {
      const buf = Buffer.from(respBytes);
      const total = buf.readUInt32BE(6);
      const bodyLen = buf.readUInt32BE(10);
      const bodyOffset = total - bodyLen;
      const head = decodeMessage(buf.subarray(16, bodyOffset), CollectorRespHead);
      const body = decodeMessage(buf.subarray(bodyOffset), CollectorRespBody) as {
        operation?: { getCollectionList?: { items?: unknown[]; totalCount?: number; reachedBottom?: number } };
      };
      console.log(`\n=== lenient 解析 ===`);
      console.log(`head:`, JSON.stringify(head));
      const page = body.operation?.getCollectionList;
      console.log(`items 条数: ${page?.items?.length ?? 0}`);
      console.log(`totalCount: ${page?.totalCount ?? '?'}  reachedBottom: ${page?.reachedBottom ?? '?'}`);
      const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
      console.log(`第 1 条 item:`, JSON.stringify(page?.items?.[0], bigintSafe, 2)?.slice(0, 1500));
    } catch (e) {
      console.error(`lenient 解析失败:`, e);
    }
  }
}

main().catch((e) => {
  console.error('\n失败:', e);
  process.exit(1);
});
