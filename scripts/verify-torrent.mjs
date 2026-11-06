#!/usr/bin/env node
// 独立的 .torrent 校验器 —— 故意不复用 make-torrent.mjs 的任何代码。
//
// 目的：如果生成器自己就写错了（比如 piece 按文件对齐而不是按连续流切），
// 用生成器的逻辑去「校验」自己的输出只会一起错。所以这里从零解析 bencode、
// 独立重建字节流、独立算 sha1，再和种子里的 pieces / infohash 对拍。
//
// 用法:
//   node scripts/verify-torrent.mjs --torrent-dir <种子目录> --dist <产物目录> \
//     [--url-base <web seed 前缀>]
//
// 种子目录里每个 *.torrent 都按「单文件种子」校验：文件名必须匹配产物目录
// 里的同名文件，pieces / infohash / web seed URL 逐项对拍。

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- 解码器 ----------
function decode(buf, pos = 0) {
  const c = buf[pos];
  if (c === 0x69 /* i */) {
    const end = buf.indexOf(0x65, pos);
    return { value: Number(buf.subarray(pos + 1, end).toString()), next: end + 1 };
  }
  if (c === 0x6c /* l */) {
    const out = [];
    let p = pos + 1;
    while (buf[p] !== 0x65) {
      const r = decode(buf, p);
      out.push(r.value);
      p = r.next;
    }
    return { value: out, next: p + 1 };
  }
  if (c === 0x64 /* d */) {
    const out = new Map();
    let p = pos + 1;
    while (buf[p] !== 0x65) {
      const k = decode(buf, p);
      const v = decode(buf, k.next);
      out.set(k.value.toString(), v.value);
      p = v.next;
    }
    return { value: out, next: p + 1 };
  }
  if (c >= 0x30 && c <= 0x39) {
    const colon = buf.indexOf(0x3a, pos);
    const len = Number(buf.subarray(pos, colon).toString());
    const start = colon + 1;
    return { value: buf.subarray(start, start + len), next: start + len };
  }
  throw new Error(`bencode 解析失败 @${pos}: byte=${c}`);
}

// 找出 info 段在原始字节里的精确区间（用于重算 infohash）。
function findInfoSlice(buf) {
  let p = 1;
  while (buf[p] !== 0x65) {
    const k = decode(buf, p);
    const v = decode(buf, k.next);
    if (k.value.toString() === 'info')
      return { info: v.value, slice: buf.subarray(k.next, v.next) };
    p = v.next;
  }
  throw new Error('找不到 info');
}

// 校验单个种子。返回 { ok, infohash, name }。
function verifyOne(torrentPath, distDir, urlBase) {
  const raw = readFileSync(torrentPath);
  const { info, slice } = findInfoSlice(raw);
  const pieceLength = info.get('piece length');
  const piecesBlob = info.get('pieces');
  const declared = [];
  for (let i = 0; i < piecesBlob.length; i += 20)
    declared.push(piecesBlob.subarray(i, i + 20).toString('hex'));

  let ok = true;
  const a = (cond, msg) => {
    if (!cond) {
      console.error(`  ✗ ${msg}`);
      ok = false;
    } else console.log(`  ✓ ${msg}`);
  };

  // 1) 结构与元数据
  const name = info.get('name').toString();
  a(name.length > 0, `info.name = ${name}`);
  a(pieceLength > 0 && pieceLength % 1024 === 0, `piece length = ${pieceLength}`);

  // 2) 必须是单文件种子，且指回产物目录里的真实文件
  const single = info.get('length') !== undefined;
  a(single, '是单文件种子（info 里用 length 而不是 files）');
  if (!single) return { ok: false, infohash: '', name };

  const size = Number(info.get('length'));
  const diskPath = join(distDir, name);
  let diskSize;
  try {
    diskSize = statSync(diskPath).size;
  } catch {
    diskSize = -1;
  }
  a(diskSize === size, `产物目录里有同名文件且大小一致 (种子 ${size} / 磁盘 ${diskSize})`);
  if (diskSize < 0) return { ok: false, infohash: '', name };

  // 3) 按 BT 规则重算 piece
  const data = readFileSync(diskPath);
  const expected = [];
  for (let off = 0; off < data.length; off += pieceLength) {
    expected.push(
      createHash('sha1')
        .update(data.subarray(off, Math.min(off + pieceLength, data.length)))
        .digest('hex'),
    );
  }
  a(
    expected.length === declared.length,
    `piece 数量一致 (重算 ${expected.length} / 种子 ${declared.length})`,
  );
  const bad = expected.filter((h, i) => h !== declared[i]).length;
  a(bad === 0, `全部 ${expected.length} 个 piece 哈希匹配`);

  // 4) infohash 自洽
  const infoHash = createHash('sha1').update(slice).digest('hex');
  a(/^[0-9a-f]{40}$/.test(infoHash), `infohash = ${infoHash}`);

  // 5) 字典 key 必须按字节序升序（BEP 3），真实客户端会因此拒绝种子
  for (const [map, label] of [
    [decode(raw, 0).value, '顶层'],
    [info, 'info'],
  ]) {
    const keys = [...map.keys()];
    const sorted = [...keys].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    a(keys.join('\u0000') === sorted.join('\u0000'), `${label} key 有序: ${keys.join(', ')}`);
  }

  // 6) web seed
  //
  // 单文件种子必须用「数组」形式，且唯一那一条就是该文件的完整 URL。
  // 实测语义（aria2 + libtorrent 一致）：
  //   - 数组形式：每个元素当作候选地址**原样**使用（单文件种子下即精确 URL）。
  //   - 字符串前缀形式：客户端拼 <前缀>/<info.name>，或直接请求前缀本身，
  //     对平铺的 GitHub Release 资产不可用。
  const urlList = decode(raw, 0).value.get('url-list');
  if (urlBase) {
    const prefix = urlBase.replace(/\/+$/, '');
    a(Array.isArray(urlList), 'url-list 是数组形式');
    if (Array.isArray(urlList)) {
      const urls = urlList.map((u) => u.toString());
      const expectedUrl = `${prefix}/${name}`;
      a(urls.length === 1 && urls[0] === expectedUrl, `web seed 是精确 URL: ${urls[0]}`);
      if (urls[0] !== expectedUrl) console.error(`    ✗ 应为: ${expectedUrl}`);
    }
  } else {
    a(urlList === undefined, '未提供 urlBase 时不写入 url-list');
  }

  return { ok, infohash: infoHash, name };
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const torrentDir = arg('--torrent-dir');
const distDir = arg('--dist');
const urlBase = arg('--url-base');

if (!torrentDir || !distDir) {
  console.error(
    '用法: node scripts/verify-torrent.mjs --torrent-dir <种子目录> --dist <产物目录> [--url-base URL前缀]',
  );
  process.exit(2);
}

const torrents = readdirSync(torrentDir)
  .filter((f) => f.endsWith('.torrent'))
  .sort();
if (torrents.length === 0) {
  console.error(`✗ ${torrentDir} 里没有 .torrent`);
  process.exit(1);
}

let failures = 0;
const results = [];
for (const t of torrents) {
  console.log(`\n== ${t} ==`);
  const r = verifyOne(join(torrentDir, t), distDir, urlBase);
  if (!r.ok) failures++;
  results.push(r);
}

console.log('');
if (failures > 0) {
  console.error(`✗ ${failures}/${torrents.length} 个种子校验失败`);
  process.exit(1);
}
console.log(`✓ ${torrents.length} 个种子全部通过校验`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `torrent_count=${torrents.length}`,
      'infohashes<<INFOHASH_EOF',
      ...results.map((r) => `${r.name}\t${r.infohash}`),
      'INFOHASH_EOF',
      '',
    ].join('\n'),
  );
}
