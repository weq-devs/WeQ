#!/usr/bin/env node
/**
 * 通话留痕分析器（配合 `apps/desktop/src/main/call_trace.ts` 产出的文件）。
 *
 *   node scripts/analyze-call-trace.mjs <call-trace-*.log> [--dump-media]
 *
 * 它只回答一个问题：**「对端开摄像头」在协议上长什么样**。输出按时间顺序，
 * 把三类包分开统计：
 *
 *   - GCS `0x28`：解出 body_type，bt=3 再解出房间事件号（`CallEvent`）；
 *   - 媒体 `0x5b`：解出 subType，按 subType 分桶算「首次出现 / 包数 / 总字节」；
 *   - relay `0x02`：只计数。
 *
 * 最后给出「首次出现视频子类型（0x02/0x03/0x07）的时刻」前后各 2 秒内出现过的
 * 所有 GCS 事件 —— 那就是「开摄像头」对应的控制面信号。
 *
 * 不依赖 `@weq/protocol`：脚本要能在没装 node_modules 的地方跑（比如把日志
 * 拷到另一台机器上分析）。protobuf 只解两层，够用了。
 */

import { readFileSync } from 'node:fs';

const GCS_STX = 0x28;
const MEDIA_STX = 0x5b;

/** `0x5b` 的 subType → 名字。视频那三个是本次要确认的重点。 */
const SUBTYPE_NAMES = {
  1: 'audio',
  2: 'video-max',
  3: 'video-min',
  7: 'video-screen',
  14: 'qfb',
};

/** GCS body_type → 名字。 */
const BODY_TYPE_NAMES = {
  1: 'authReq',
  2: 'authRsp',
  3: 'notifyPush',
  4: 'notifyAck',
  9: 'ctrlPush',
  10: 'ctrlAck',
  11: 'configPush',
  12: 'configAck',
  15: 'statusReport',
  16: 'statusReportAck',
  23: 'heartbeat',
  24: 'heartbeatAck',
  27: 'peerJoin',
  28: 'peerJoinAck',
  75: 'mediaCtrlPush',
  76: 'mediaCtrlAck',
  79: 'dialTest',
  1003: 'logout',
};

/** 房间事件号 → 名字（与 `packages/protocol/src/call/gcs.ts` 的 `CallEvent` 一致）。 */
const EVENT_NAMES = {
  1: 'invited',
  2: 'entered',
  3: 'accepted',
  4: 'ringing',
  5: 'connectFail',
  6: 'refusedAlt',
  7: 'logout',
  8: 'timeout',
  9: 'kickOut',
  10: 'dataChange',
};

// ─────────────────────────── protobuf 最小解析 ───────────────────────────

/** 读一个 varint，返回 [值, 下一个偏移]；越界返回 [null, 偏移]。 */
function readVarint(buf, start) {
  let value = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 63n) return [null, i];
  }
  return [null, i];
}

/** 平铺解析一层 protobuf，返回 [{field, wire, value?, bytes?, fixed32?}]。 */
function parsePb(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const [rawTag, n1] = readVarint(buf, i);
    if (rawTag === null) break;
    i = n1;
    const field = Number(rawTag >> 3n);
    const wire = Number(rawTag & 7n);
    if (field === 0) break;
    if (wire === 0) {
      const [v, n2] = readVarint(buf, i);
      if (v === null) break;
      out.push({ field, wire, value: v });
      i = n2;
    } else if (wire === 2) {
      const [len, n2] = readVarint(buf, i);
      if (len === null) break;
      const end = n2 + Number(len);
      if (end > buf.length) break;
      out.push({ field, wire, bytes: buf.subarray(n2, end) });
      i = end;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ field, wire, fixed32: buf.readUInt32BE(i) });
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

function pbVarint(buf, field) {
  const hit = parsePb(buf).find((x) => x.field === field && x.wire === 0);
  return hit === undefined ? undefined : Number(hit.value);
}

function pbBytes(buf, field) {
  return parsePb(buf).find((x) => x.field === field && x.wire === 2)?.bytes;
}

// ─────────────────────────── 包解析 ───────────────────────────

/** GCS 包：`28 | headLen(4) | bodyLen(4) | head | body | 29`。 */
function parseGcs(data) {
  if (data.length < 11) return null;
  const headLen = data.readUInt32BE(1);
  const bodyLen = data.readUInt32BE(5);
  if (data.length < 10 + headLen + bodyLen) return null;
  const head = data.subarray(9, 9 + headLen);
  const body = data.subarray(9 + headLen, 9 + headLen + bodyLen);
  const bodyType = pbVarint(head, 6) ?? 0;
  return {
    bodyType,
    typeId: pbVarint(head, 4) ?? 0,
    sessionTs: pbVarint(head, 3) ?? 0,
    body,
  };
}

/** bt=3 的房间事件：`f1=seq, f2={f1=peerUin, f3=event}, f3=exitReason`。 */
function parseCallEvent(body) {
  const info = pbBytes(body, 2);
  if (!info) return null;
  return {
    seq: pbVarint(body, 1) ?? 0,
    peerUin: pbVarint(info, 1) ?? 0,
    event: pbVarint(info, 3) ?? 0,
    exitReason: pbVarint(body, 3) ?? 0,
  };
}

/** bt=75 媒体控制推送：`f1=configName, f2=type, f5=json, f6=hash`。 */
function parseMediaCtrl(body) {
  const name = pbBytes(body, 1);
  const json = pbBytes(body, 5);
  const hash = pbBytes(body, 6);
  return {
    name: name ? Buffer.from(name).toString('utf8').trim() : null,
    type: pbVarint(body, 2),
    json: json ? Buffer.from(json).toString('utf8') : null,
    hash: hash ? Buffer.from(hash).toString('utf8') : null,
  };
}

/** 媒体包 17 字节头：`[3]=subType, [5:9]=seq, [9:13]=ts, [13:17]=ssrc/tick`。 */
function parseMediaHeader(data) {
  if (data.length < 17) return null;
  return {
    subType: data[3],
    seq: data.readUInt32BE(5),
    timestamp: data.readUInt32BE(9),
    ssrc: data.readUInt32BE(13),
  };
}

// ─────────────────────────── 主流程 ───────────────────────────

const [, , file, ...flags] = process.argv;
if (!file) {
  console.error('用法：node scripts/analyze-call-trace.mjs <call-trace-*.log> [--dump-media]');
  process.exit(2);
}
const dumpMedia = flags.includes('--dump-media');

const lines = readFileSync(file, 'utf8').split('\n');
const marks = [];
/** { at, dir, stx, len, data } */
const packets = [];

for (const line of lines) {
  if (!line) continue;
  if (line.startsWith('#')) {
    marks.push(line);
    continue;
  }
  // `1761351000123 > gcs len=42 peer=1.2.3.4:8000 <hex>`
  const m = /^(\d+) ([<>]) (.*?) len=(\d+) peer=(\S+) ([0-9a-f]*)$/.exec(line);
  if (!m) continue;
  const hex = m[6];
  if (!hex) continue;
  packets.push({
    at: Number(m[1]),
    dir: m[2],
    desc: m[3],
    len: Number(m[4]),
    peer: m[5],
    data: Buffer.from(hex, 'hex'),
  });
}

if (packets.length === 0) {
  console.error('文件里没有可解析的包（格式不对，或抓包时没有通话流量）');
  process.exit(1);
}

const t0 = packets[0].at;
const rel = (at) => `+${((at - t0) / 1000).toFixed(3)}s`;

console.log(`文件：${file}`);
console.log(`包数：${packets.length}，跨度：${rel(packets.at(-1).at)}`);
for (const mark of marks) console.log(mark);

// ── 媒体子类型统计 ──
const media = new Map(); // subType → { firstAt, firstDir, count, bytes }
const videoFirst = []; // 首个视频包的时刻
for (const p of packets) {
  if (p.data[0] !== MEDIA_STX) continue;
  const h = parseMediaHeader(p.data);
  if (!h) continue;
  const sub = h.subType;
  const name = SUBTYPE_NAMES[sub] ?? `sub-0x${sub.toString(16)}`;
  let slot = media.get(name);
  if (!slot) {
    slot = { firstAt: p.at, firstDir: p.dir, count: 0, bytes: 0, sub };
    media.set(name, slot);
    if (sub === 0x02 || sub === 0x03 || sub === 0x07) videoFirst.push({ at: p.at, name });
  }
  slot.count++;
  slot.bytes += p.len;
}

console.log('\n=== 媒体包（0x5b）按 subType ===');
for (const [name, s] of [...media.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt)) {
  console.log(
    `  ${name.padEnd(14)} 首次 ${rel(s.firstAt)} (${s.firstDir})  ` +
      `${s.count} 包 / ${(s.bytes / 1024).toFixed(1)} KiB`,
  );
}

// ── GCS 包统计 ──
const gcs = new Map(); // bodyType → { count, firstAt }
const events = []; // { at, event, peerUin, seq, exitReason, dir }
const mediaCtrl = [];
for (const p of packets) {
  if (p.data[0] !== GCS_STX) continue;
  const g = parseGcs(p.data);
  if (!g) continue;
  const name = BODY_TYPE_NAMES[g.bodyType] ?? `bt-${g.bodyType}`;
  const slot = gcs.get(name) ?? { count: 0, firstAt: p.at };
  slot.count++;
  gcs.set(name, slot);

  if (g.bodyType === 3) {
    const ev = parseCallEvent(g.body);
    if (ev) events.push({ at: p.at, dir: p.dir, ...ev });
  }
  if (g.bodyType === 75) {
    mediaCtrl.push({ at: p.at, dir: p.dir, ...parseMediaCtrl(g.body) });
  }
}

console.log('\n=== GCS 包（0x28）按 body_type ===');
for (const [name, s] of [...gcs.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt)) {
  console.log(`  ${name.padEnd(18)} ${String(s.count).padStart(5)} 包  首次 ${rel(s.firstAt)}`);
}

console.log('\n=== 房间事件（bt=3）===');
for (const e of events) {
  console.log(
    `  ${rel(e.at)} ${e.dir} seq=${e.seq} event=${e.event}` +
      `(${EVENT_NAMES[e.event] ?? '?'}) peer=${e.peerUin} exitReason=${e.exitReason}`,
  );
}

if (mediaCtrl.length > 0) {
  console.log('\n=== 媒体控制推送（bt=75）===');
  for (const c of mediaCtrl) {
    console.log(
      `  ${rel(c.at)} ${c.dir} name=${c.name} type=${c.type ?? '?'} hash=${c.hash ?? '-'}`,
    );
    if (c.json) {
      // JSON 可能很长（码率表），单行输出便于 diff。
      console.log(`      json: ${c.json.replace(/\s+/g, ' ').slice(0, 4000)}`);
    }
  }
}

// ── 关键：视频首包前后的控制面信号 ──
if (videoFirst.length > 0) {
  console.log('\n=== 首次出现视频包前后 2 秒内的控制面信号 ===');
  for (const v of videoFirst) {
    console.log(`\n[${v.name}] 首包 ${rel(v.at)}`);
    const lo = v.at - 2000;
    const hi = v.at + 2000;
    for (const p of packets) {
      if (p.at < lo || p.at > hi) continue;
      if (p.data[0] !== GCS_STX) continue;
      const g = parseGcs(p.data);
      if (!g) continue;
      const name = BODY_TYPE_NAMES[g.bodyType] ?? `bt-${g.bodyType}`;
      let extra = '';
      if (g.bodyType === 3) {
        const ev = parseCallEvent(g.body);
        if (ev) extra = ` event=${ev.event}(${EVENT_NAMES[ev.event] ?? '?'}) peer=${ev.peerUin}`;
      }
      if (g.bodyType === 75) {
        const c = parseMediaCtrl(g.body);
        extra = ` name=${c.name} type=${c.type ?? '?'}`;
      }
      console.log(`  ${rel(p.at)} ${p.dir} ${name} len=${p.len}${extra}`);
    }
  }
} else {
  console.log('\n⚠️ 没有抓到任何视频子类型（0x02/0x03/0x07）的包。');
  console.log('   可能原因：对端没真的开摄像头 / 通话没接通 / 视频走的是另一条连接。');
}

if (dumpMedia) {
  console.log('\n=== 媒体包头（前 40 个非音频包）===');
  let shown = 0;
  for (const p of packets) {
    if (p.data[0] !== MEDIA_STX) continue;
    const h = parseMediaHeader(p.data);
    if (!h || h.subType === 0x01) continue;
    console.log(
      `  ${rel(p.at)} ${p.dir} sub=0x${h.subType.toString(16)} seq=${h.seq} ` +
        `ts=${h.timestamp} ssrc=${h.ssrc} len=${p.len} ` +
        `payload=${p.data.subarray(17, 49).toString('hex')}`,
    );
    if (++shown >= 40) break;
  }
}
