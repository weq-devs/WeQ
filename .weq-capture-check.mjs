/** 临时排查：root 抓包，对实时帧同时跑 native 解密与手工 TEA，直接对比。用完即删。 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CFG = '/home/h3cof6/.config/weq/config/accounts/1707889225_03ed321f.json';
const p = resolve(process.cwd(), 'native/linux/x64/nt_helper.node');
process.chdir(dirname(p));
const require = createRequire(import.meta.url);
const addon = require(p);

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const D2KEY_HEX = cfg.session?.d2Key;
const UIN = cfg.uin;
const PID = cfg.qqPid ?? 60951;
console.log(`pid=${PID} uin=${UIN} d2key=${D2KEY_HEX ? `${D2KEY_HEX.slice(0, 6)}…` : '(缺失)'}`);

// ---- 手工 TEA（与仓库 .weq-msf-decode.mjs 同款） ----
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const DELTA = 0x9e3779b9;
const ROUNDS = 16;
const ch = (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '.');
function decryptBlock(x, y, k) {
  let sum = (DELTA * ROUNDS) >>> 0;
  for (let i = 0; i < ROUNDS; i++) {
    y = (y - (((x + sum) ^ ((x << 4) + k[2]) ^ ((x >>> 5) + k[3])) >>> 0)) >>> 0;
    x = (x - (((y + sum) ^ ((y << 4) + k[0]) ^ ((y >>> 5) + k[1])) >>> 0)) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }
  return [x, y];
}
function teaDecrypt(data, key) {
  const k = [0, 1, 2, 3].map((i) => be32(key, i * 4));
  const out = new Uint8Array(data.length);
  let plainXor = 0n;
  let prevXor = 0n;
  const rd = (o) => (BigInt(be32(data, o)) << 32n) | BigInt(be32(data, o + 4));
  const wr = (o, v) => {
    for (let i = 0; i < 8; i++) out[o + i] = Number((v >> BigInt(56 - i * 8)) & 0xffn);
  };
  for (let i = 0; i < data.length; i += 8) {
    const block = rd(i);
    plainXor ^= block;
    const [x, y] = decryptBlock(
      Number(plainXor >> 32n) >>> 0,
      Number(plainXor & 0xffffffffn) >>> 0,
      k,
    );
    plainXor = (BigInt(x) << 32n) | BigInt(y);
    wr(i, plainXor ^ prevXor);
    prevXor = block;
  }
  return out;
}
/** 手工解一帧：从 uin 之后的密文起解，找自洽的 SSO 头。 */
function _manualDecrypt(raw) {
  const key = Buffer.from(D2KEY_HEX, 'hex');
  const uinBytes = Buffer.from(UIN, 'ascii');
  const uinOff = Buffer.from(raw).indexOf(uinBytes);
  if (uinOff < 0) return 'no-uin';
  const cands = [uinOff + 10, uinOff + 11, uinOff + 12, uinOff + 14];
  for (const s of cands) {
    const len = raw.length - s;
    if (len <= 0 || len % 8 !== 0) continue;
    const dec = teaDecrypt(raw.subarray(s), key);
    for (let f = 0; f <= 6; f++) {
      const q = dec.subarray(f, dec.length - 7);
      if (q.length < 16) continue;
      const hl = be32(q, 0);
      const bl = be32(q, hl);
      if (hl >= 8 && hl <= q.length && hl + bl === q.length) {
        const head = [...q.subarray(0, 40)].map(ch).join('');
        return `解出 (start=${s} fill=${f} headlen=${hl} bodylen=${bl}) 头="${head}"`;
      }
    }
  }
  return '未解出自洽布局';
}
// ---- 手工 TEA end ----

async function runCapture(label, d2key) {
  console.log(`\n===== ${label} =====`);
  try {
    const sess = await addon.startCapture(PID, { iface: 'auto', port: 'auto', d2key });
    console.log('startCapture =', JSON.stringify(sess));
  } catch (e) {
    console.log('startCapture ERR:', e.message);
    return [];
  }
  let cursor;
  const seen = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const batch = await addon.takeFrames(PID, { cursor, waitMs: 1500 }).catch(() => ({
      frames: [],
      nextCursor: cursor,
    }));
    cursor = batch.nextCursor;
    seen.push(...batch.frames);
  }
  await addon.stopCapture(PID).catch(() => {});
  const enc = seen.filter((x) => x.encryptType !== 0);
  const withPlain = enc.filter((x) => (x.plain?.length ?? 0) > 0);
  console.log(`  et≠0 帧 ${enc.length}，native 解出 plain 的 ${withPlain.length}`);
  return enc;
}

const strFrames = await runCapture('d2key = string', D2KEY_HEX);
const bufFrames = await runCapture('d2key = Buffer', Buffer.from(D2KEY_HEX, 'hex'));

const all = [...strFrames, ...bufFrames].map((f) => ({
  direction: f.direction,
  proto: f.proto,
  encryptType: f.encryptType,
  seq: f.seq,
  cmd: f.cmd ?? null,
  rawHex: Buffer.from(f.raw ?? []).toString('hex'),
}));
writeFileSync('/tmp/weq-frames.json', JSON.stringify(all, null, 2));
console.log(`\n写入 /tmp/weq-frames.json：${all.length} 帧（含 c2s/s2c）`);
