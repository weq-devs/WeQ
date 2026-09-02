/**
 * 用手写 pskey/skey 直接打 collector.weiyun.com,不注入 QQ。
 *
 * 先走生产网络路径 getCollectionListNetwork(信封编码、分页、lenient 解码全部一致);
 * 失败时自动补发一页原始请求并 dump 状态码 / 响应头 / 原始字节 / 文本解释,
 * 用于区分「pskey 过期 / 风控 / 网关报错 / 网络层被拦」。
 *
 * 注意:collector 报文只把 pskey 放进 head.ticket 和 Cookie `vi`,skey 不参与
 * collector 协议(带上仅用于核对与注入路径一致)。
 *
 * Run:  pnpm tsx ./packages/service/tools/collection_static_key.ts <uin> <pskey> [skey] [count]
 * 也可用环境变量 WEQ_COLLECT_UIN / WEQ_COLLECT_PSKEY / WEQ_COLLECT_SKEY 传参。
 */

import { ProtoMsg } from '@weq/codec';
import { decodeMessage, type CollectionItem } from '@weq/db';
import {
  CollectorReqHead,
  CollectorReqBody,
  CollectorRespHead,
} from '@weq/codec/proto/collection/index';
import type { WebCredential } from '../src/account/web/credential';
import { getCollectionListNetwork } from '../src/account/web/collection';

const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const HOST = 'collector.weiyun.com';
const TICKET_TYPE = 27;
const APP_ID = 5_004;
const OPERATION_ID = 20_000;
const CLIENT_VERSION = 0x6105f5e164fn;
const INITIAL_TIMESTAMP = 0xffff_ffff_ffff_ffffn;
const MAGIC = Uint8Array.from([0x20, 0x13, 0x03, 0x29]);
const VERSION = Uint8Array.from([0x00, 0x01]);

function mask(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

function preview(it: CollectionItem): string {
  const s = it.summary;
  if (s.richMediaSummary)
    return s.richMediaSummary.brief || s.richMediaSummary.title || '(rich media)';
  if (s.linkSummary) return `${s.linkSummary.title ?? ''} → ${s.linkSummary.url ?? ''}`;
  if (s.fileSummary) return s.fileSummary.fileInfo?.name ?? '(file)';
  if (s.videoSummary) return `video ${s.videoSummary.title ?? ''}`;
  if (s.audioSummary) return `audio ${s.audioSummary.duration ?? '?'}ms`;
  if (s.locationSummary)
    return `${s.locationSummary.name ?? ''} @${s.locationSummary.latitude ?? '?'},${s.locationSummary.longitude ?? '?'}`;
  if (s.gallerySummary) return `gallery ×${s.gallerySummary.picList?.length ?? 0}`;
  if (s.textSummary) return s.textSummary.text ?? '(text)';
  return '(unknown)';
}

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
        count: 50,
        searchDown: 1,
      },
    },
  });
  return encodeEnvelope(head, body);
}

function dumpResponse(label: string, bytes: Uint8Array): void {
  const buf = Buffer.from(bytes);
  console.log(`\n=== ${label} ===`);
  console.log(`字节数: ${buf.length}`);
  console.log(`hex (前 256B): ${buf.subarray(0, 256).toString('hex')}`);
  console.log(`--- 当作 UTF-8 文本 (前 1000 字符) ---`);
  console.log(buf.subarray(0, 1000).toString('utf8'));
  if (buf.length >= 16) {
    console.log(`--- envelope 头 ---`);
    console.log(
      `magic ok: ${buf.subarray(0, 4).equals(Buffer.from(MAGIC))} (${buf.subarray(0, 4).toString('hex')})`,
    );
    console.log(`totalLength(6): ${buf.readUInt32BE(6)}  实际: ${buf.length}`);
    console.log(`bodyLength(10): ${buf.readUInt32BE(10)}`);
  } else {
    console.log(`(不足 16 字节,不可能是 envelope —— 服务器没走 collector 二进制协议)`);
  }
}

/** 补发一页原始请求,把服务器真实返回 dump 出来。 */
async function rawProbe(uin: string, pskey: string): Promise<void> {
  const reqBytes = buildRequest(BigInt(uin), pskey);
  const cookie = `uin=${uin};vt=${TICKET_TYPE};vi=${pskey};appid=${APP_ID}`;
  console.log(`\n[static] 原始诊断:POST ${ENDPOINT}`);
  console.log(`[static] Cookie: ${cookie.slice(0, 40)}...(vi 省略)`);
  console.log(`[static] 请求字节数: ${reqBytes.length}`);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Cookie: cookie,
        Host: HOST,
        Range: 'bytes=0-',
      },
      body: Buffer.from(reqBytes),
    });
  } catch (error) {
    console.error(`\n[static] 请求本身抛错(网络层/DNS/TLS 被拦?):`, error);
    return;
  }

  console.log(`\n=== HTTP 响应 ===`);
  console.log(`status: ${res.status} ${res.statusText}`);
  console.log(`headers:`);
  res.headers.forEach((v, k) => {
    console.log(`  ${k}: ${v}`);
  });

  const respBytes = new Uint8Array(await res.arrayBuffer());
  dumpResponse('响应报文 (收到的)', respBytes);

  if (respBytes.length > 16) {
    try {
      const buf = Buffer.from(respBytes);
      const total = buf.readUInt32BE(6);
      const bodyLen = buf.readUInt32BE(10);
      const bodyOffset = total - bodyLen;
      const head = decodeMessage(buf.subarray(16, bodyOffset), CollectorRespHead) as {
        retCode?: number;
        retMsg?: string;
        promptMsg?: string;
      };
      console.log(`\n--- 信封解析 ---`);
      console.log(
        `retCode: ${head.retCode ?? '?'}  retMsg: ${head.retMsg ?? ''}  promptMsg: ${head.promptMsg ?? ''}`,
      );
      if (head.retCode !== 0) {
        console.log(
          `!! 服务端返回错误码 ${head.retCode}:${head.retMsg || head.promptMsg || ''} —— 凭据/参数问题`,
        );
      }
    } catch (e) {
      console.error(`信封解析失败:`, e);
    }
  }
}

async function main(): Promise<void> {
  const uin = process.argv[2] ?? process.env.WEQ_COLLECT_UIN ?? '';
  const pskey = process.argv[3] ?? process.env.WEQ_COLLECT_PSKEY ?? '';
  const skey = process.argv[4] ?? process.env.WEQ_COLLECT_SKEY ?? '';
  const count = Math.max(1, Number(process.argv[5] ?? 50) || 50);

  if (!uin || !pskey) {
    throw new Error(
      '用法: pnpm tsx ./packages/service/tools/collection_static_key.ts <uin> <pskey> [skey] [count]',
    );
  }

  console.log(`[static] uin  = ${uin}`);
  console.log(`[static] pskey= ${mask(pskey)} (长度 ${pskey.length})`);
  console.log(`[static] skey = ${mask(skey)} (长度 ${skey.length})`);
  console.log(
    `[static] 注:collector 报文只把 pskey 放进 head.ticket + Cookie vi,skey 不参与请求。`,
  );
  console.log(`[static] 目标: 拉取前 ${count} 条(分页内部自动处理)...\n`);

  const cred: WebCredential = { uin, skey, pskey };
  try {
    const page = await getCollectionListNetwork(cred, count);
    console.log(`[static] ✅ 成功,拿到 ${page.items.length} 条,还有更多: ${page.hasMore}`);
    page.items.forEach((it, i) => {
      const who = it.author?.strId || it.author?.uid || '?';
      const when = it.collectTime ? new Date(it.collectTime).toLocaleString() : '?';
      console.log(
        `  ${String(i + 1).padStart(4)}. [${it.kind.padEnd(9)}] ${when} by ${who}: ${preview(it).slice(0, 90)}`,
      );
    });

    const dist = new Map<string, number>();
    for (const it of page.items) dist.set(it.kind, (dist.get(it.kind) ?? 0) + 1);
    console.log('\n[static] 类型分布:');
    [...dist.entries()].sort().forEach(([k, n]) => {
      console.log(`   ${k.padEnd(12)} ${n}`);
    });
    return;
  } catch (error) {
    console.error(`\n[static] 生产路径失败:`, error);
    console.log(`\n[static] 下面重新发一页原始请求,看服务器到底回了什么...`);
    await rawProbe(uin, pskey);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n[static] 失败:', e);
  process.exit(1);
});
