/**
 * 爆破 worker：扫描 [lo, hi) 子区间，命中即通过 SharedArrayBuffer 通知主线程早退。
 * 对标 Rust rayon find_any：任一 worker 命中，其余尽快停。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { md5Hex16 } from './md5_fast';

const DELTA = 0x9e3779b9;

function keyWords(keyAscii: Uint8Array, k: Uint32Array): void {
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    k[i] = ((keyAscii[o]! << 24) | (keyAscii[o + 1]! << 16) | (keyAscii[o + 2]! << 8) | keyAscii[o + 3]!) >>> 0;
  }
}
function teaDec(v0: number, v1: number, k: Uint32Array): [number, number] {
  let s = Math.imul(DELTA, 16) >>> 0;
  for (let i = 0; i < 16; i++) {
    v1 = (v1 - ((((v0 << 4) + k[2]!) ^ (v0 + s) ^ ((v0 >>> 5) + k[3]!)) >>> 0)) >>> 0;
    v0 = (v0 - ((((v1 << 4) + k[0]!) ^ (v1 + s) ^ ((v1 >>> 5) + k[1]!)) >>> 0)) >>> 0;
    s = (s - DELTA) >>> 0;
  }
  return [v0 >>> 0, v1 >>> 0];
}
function fastTestKey(c0: number, c1: number, c2: number, c3: number, keyAscii: Uint8Array, k: Uint32Array): boolean {
  keyWords(keyAscii, k);
  const [d0, d1] = teaDec(c0, c1, k);
  const [d2, d3] = teaDec((c2 ^ d0) >>> 0, (c3 ^ d1) >>> 0, k);
  const out2 = (d2 ^ c0) >>> 0;
  const out3 = (d3 ^ c1) >>> 0;
  const buf = new Uint8Array(16);
  buf[0] = (d0 >>> 24) & 0xff; buf[1] = (d0 >>> 16) & 0xff; buf[2] = (d0 >>> 8) & 0xff; buf[3] = d0 & 0xff;
  buf[4] = (d1 >>> 24) & 0xff; buf[5] = (d1 >>> 16) & 0xff; buf[6] = (d1 >>> 8) & 0xff; buf[7] = d1 & 0xff;
  buf[8] = (out2 >>> 24) & 0xff; buf[9] = (out2 >>> 16) & 0xff; buf[10] = (out2 >>> 8) & 0xff; buf[11] = out2 & 0xff;
  buf[12] = (out3 >>> 24) & 0xff; buf[13] = (out3 >>> 16) & 0xff; buf[14] = (out3 >>> 8) & 0xff; buf[15] = out3 & 0xff;
  const pad = buf[0]! & 7;
  const start = 1 + pad + 2;
  if (start + 6 > 16) return false;
  return (
    buf[start] === 0x47 && buf[start + 1] === 0x49 && buf[start + 2] === 0x46 && buf[start + 3] === 0x38 &&
    (buf[start + 4] === 0x39 || buf[start + 4] === 0x37) && buf[start + 5] === 0x61
  );
}

const { lo, hi, c0, c1, c2, c3, flag } = workerData as {
  lo: number; hi: number; c0: number; c1: number; c2: number; c3: number; flag: Int32Array;
};

const keyAscii = new Uint8Array(16);
const k = new Uint32Array(4);
const CHECK = 8192; // 每扫这么多个检查一次早退标志

let found = -1;
for (let ts = hi - 1; ts >= lo; ts--) {
  md5Hex16(ts, keyAscii);
  if (fastTestKey(c0, c1, c2, c3, keyAscii, k)) { found = ts; break; }
  if ((ts & (CHECK - 1)) === 0 && Atomics.load(flag, 0) !== 0) break;
}

if (found !== -1) Atomics.store(flag, 0, 1);
parentPort!.postMessage(found);
