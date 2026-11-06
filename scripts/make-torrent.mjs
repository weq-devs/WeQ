#!/usr/bin/env node
// 生成带 web seed 的 .torrent 与 magnet 链接。
//
// 设计要点：
// - 只用 Node 标准库，CI / 本地都能跑，不依赖 mktorrent。
// - 多文件模式：所有产物放进同一个目录，作为一个 BT 多文件种子，
//   下载端解压即得完整产物树；同时只用一条 magnet / 一个 .torrent。
// - web seed（BEP 19）指向 GitHub Release 直链，兜住「没人做种」的场景 ——
//   Actions runner 跑完就销毁，没有 web seed 的 magnet 本质上是个死链。
//
// 用法：
//   node scripts/make-torrent.mjs --dir <产物目录> --out <a.torrent> \
//     --name <显示名> --url-base <webseed 前缀> [--piece-size 1MiB]

import { createHash } from 'node:crypto';
import { createReadStream, statSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';

// ---------- bencode ----------
// 支持 Uint8Array / string / number / Array / Map（有序字典）。
function bencode(value) {
  if (value instanceof Uint8Array) {
    return Buffer.concat([Buffer.from(`${value.length}:`), Buffer.from(value)]);
  }
  if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${buf.length}:`), buf]);
  }
  if (typeof value === 'number') {
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    const parts = [Buffer.from('l')];
    for (const item of value) parts.push(bencode(item));
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  if (value instanceof Map) {
    // 字典的 key 必须按原始字节序升序，这是 BEP 3 硬要求。
    const keys = [...value.keys()].map((k) => Buffer.from(k, 'utf8'));
    keys.sort(Buffer.compare);
    const parts = [Buffer.from('d')];
    for (const k of keys) {
      parts.push(bencode(k.toString('utf8')));
      parts.push(bencode(value.get(k.toString('utf8'))));
    }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new Error(`bencode: 不支持的类型 ${typeof value}`);
}

export function bencodeToString(value) {
  return bencode(value).toString('latin1');
}

// ---------- 工具 ----------
export function parseSize(text) {
  const m = /^(\d+)(KiB|MiB|KiB|KB|MB|GiB|GB)?$/i.exec(String(text).trim());
  if (!m) throw new Error(`无法解析大小: ${text}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  const mul =
    unit === 'B'
      ? 1
      : unit === 'KIB' || unit === 'KB'
        ? 1024
        : unit === 'MIB' || unit === 'MB'
          ? 1024 ** 2
          : unit === 'GIB' || unit === 'GB'
            ? 1024 ** 3
            : 1;
  return n * mul;
}

// 递归列出目录下所有文件，返回按 posix 相对路径排序的列表。
function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
      // 符号链接 / 特殊文件直接忽略：torrent 里没法表达，也容易把 CI 带沟里。
    }
  };
  visit(root);
  return out
    .map((full) => ({
      full,
      rel: relative(root, full).split(sep).join(posix.sep),
      size: statSync(full).size,
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// ---------- 分块哈希 ----------
// BT 的 piece 是「跨文件连续字节流」切块：一个文件结束时直接接到下一个文件开头，
// 不补齐、不按文件对齐。所以这里必须把整棵树当一个虚拟连续流来读。
export async function hashPieces(files, pieceLength) {
  const pieces = [];
  // 预分配一块固定大小的 piece 缓冲，按 offset 往里写。
  // 早期版本用 Buffer.concat 累积下一个 chunk，每喂一个 chunk 就复制整块，
  // 是 O(pieceLength² / chunkSize)：2.6GB 数据下 16MiB piece 要 45s，
  // 1MiB 只要 5s，块越大越慢。改成原地写入后耗时与 piece 大小基本无关。
  const buf = Buffer.allocUnsafe(pieceLength);
  let filled = 0;

  const emit = (length) => {
    pieces.push(createHash('sha1').update(buf.subarray(0, length)).digest());
  };

  for (const file of files) {
    const stream = createReadStream(file.full, { highWaterMark: 1024 * 1024 });
    for await (const raw of stream) {
      let chunk = raw;
      while (chunk.length > 0) {
        const room = pieceLength - filled;
        const take = Math.min(room, chunk.length);
        chunk.copy(buf, filled, 0, take);
        filled += take;
        chunk = chunk.subarray(take);
        if (filled === pieceLength) {
          emit(pieceLength);
          filled = 0;
        }
      }
    }
  }
  // 最后不满一块的尾巴也算一个 piece（BEP 3）。
  if (filled > 0) emit(filled);

  return Buffer.concat(pieces);
}

// ---------- 主流程 ----------
export async function buildTorrent({ files, name, urlList, pieceLength, comment }) {
  if (files.length === 0) throw new Error('文件列表为空');

  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`文件数: ${files.length}  总大小: ${(total / 1024 / 1024).toFixed(1)} MiB`);
  console.log(
    `分块大小: ${(pieceLength / 1024).toFixed(0)} KiB，约 ${Math.ceil(total / pieceLength)} 块`,
  );

  const pieces = await hashPieces(files, pieceLength);

  const info = new Map();
  info.set('name', name);
  info.set('piece length', pieceLength);
  info.set('pieces', pieces);

  if (files.length === 1 && name === files[0].rel) {
    // 单文件种子：info 里是 length 而不是 files。
    info.set('length', files[0].size);
  } else {
    info.set(
      'files',
      files.map((f) => {
        const entry = new Map();
        entry.set('length', f.size);
        entry.set('path', f.rel.split('/'));
        return entry;
      }),
    );
  }

  const torrent = new Map();
  torrent.set('info', info);
  // web seed（BEP 19）。这块的坑比想象中多，都是实测出来的：
  //
  //   - 多文件种子用「字符串前缀」时，客户端拼的是
  //     <url-list>/<info.name>/<files 里的相对路径>。所以前缀必须指向
  //     「种子名上一级」的目录。
  //   - 多文件种子用「数组」时，aria2 会把每个数组项当成前缀，跟每个文件
  //     做笛卡尔积（<url>/<name>/<rel>），直接全 404。
  //   - 单文件种子用「数组」时，URL 被当作该文件的精确地址原样使用 ——
  //     实测这一点最稳，9.2MiB/s 从 GitHub Release 拉完且哈希一致。
  //   - 单文件种子用「字符串前缀」时，aria2 会直接请求前缀本身（不拼文件名）。
  //
  // GitHub Release 的资产是平铺的（没有 <种子名>/ 这层目录），所以这里
  // 统一走「每个文件一个单文件种子 + 数组形式精确 URL」，不做多文件种子。
  if (urlList && urlList.length > 0) torrent.set('url-list', urlList);
  torrent.set('creation date', Math.floor(Date.now() / 1000));
  torrent.set('created by', 'TITD drill');
  if (comment) torrent.set('comment', comment);

  const encoded = bencode(torrent);
  // infohash = bencode(info) 的 sha1，即磁力链接里 btih 的值。
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex');
  return { encoded, infoHash, files, total, pieceCount: pieces.length / 20 };
}

// 为目录下每个文件各生成一个种子（单文件种子）。
// 返回 [{ rel, size, encoded, infoHash, pieceCount }]。
export async function buildPerFileTorrents({ dir, urlBase, pieceLength, comment, exclude = [] }) {
  const files = walkFiles(dir).filter((f) => !exclude.some((re) => re.test(f.rel)));
  if (files.length === 0) throw new Error(`目录里没有可打包的文件: ${dir}`);
  const prefix = urlBase ? urlBase.replace(/\/+$/, '') : '';

  const out = [];
  for (const f of files) {
    const single = [{ ...f, rel: f.rel }];
    const urlList = prefix ? [`${prefix}/${f.rel}`] : undefined;
    const r = await buildTorrent({
      files: single,
      // 单文件种子的 name 必须等于文件相对路径（这里就是文件名），
      // 这样客户端拼出来的 URL 才和 Release 上的一致。
      name: f.rel,
      urlList,
      pieceLength,
      comment,
    });
    out.push({ rel: f.rel, size: f.size, ...r });
    console.log(`  ✓ ${f.rel}  ${r.infoHash}`);
  }
  return out;
}

export function magnetFor(infoHash, name, sizeBytes, trackers = [], webSeeds = []) {
  const parts = [
    `magnet:?xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(name)}`,
    ...trackers.map((t) => `tr=${encodeURIComponent(t)}`),
    // ws= 是磁力链接自带 web seed 的唯一途径（BEP 19 + BEP 9 扩展）。
    //
    // .torrent 里写的 url-list 只在拿到 metadata 之后才生效，而 metadata
    // 本身要靠 DHT/tracker 从 peer 取 —— 没有常驻做种者时根本取不到，
    // 客户端还没看到 web seed 就已经失败了。所以发出去的 magnet 必须
    // 自带 ws=，否则就是个死链。
    ...webSeeds.map((w) => `ws=${encodeURIComponent(w)}`),
  ];
  return { magnet: parts.join('&'), size: sizeBytes };
}

// ---------- CLI ----------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : args[i + 1];
  };

  const dir = arg('--dir');
  const outDir = arg('--out-dir');
  const urlBase = arg('--url-base');
  const pieceLength = parseSize(arg('--piece-size', '1MiB'));
  const trackerArg = arg('--tracker', '');
  const excludeArg = arg('--exclude', '');

  if (!dir || !outDir) {
    console.error(
      '用法: node scripts/make-torrent.mjs --dir <产物目录> --out-dir <输出目录> ' +
        '[--url-base <web seed 前缀>] [--piece-size 1MiB] [--tracker URL] [--exclude 正则]',
    );
    process.exit(2);
  }

  const trackers = trackerArg ? trackerArg.split(',').filter(Boolean) : [];
  const exclude = excludeArg ? excludeArg.split(',').map((s) => new RegExp(s)) : [];
  mkdirSync(outDir, { recursive: true });

  const results = await buildPerFileTorrents({
    dir,
    urlBase,
    pieceLength,
    exclude,
    comment: urlBase ? `web seed: ${urlBase}` : undefined,
  });

  // 每个文件一个 .torrent + 一份磁力链接清单。
  const lines = [];
  let totalBytes = 0;
  let totalTorrentBytes = 0;

  for (const r of results) {
    const base = r.rel.replace(/\//g, '__');
    const path = join(outDir, `${base}.torrent`);
    writeFileSync(path, r.encoded);
    const webSeeds = urlBase ? [`${urlBase.replace(/\/+$/, '')}/${r.rel}`] : [];
    const { magnet } = magnetFor(r.infoHash, r.rel, r.size, trackers, webSeeds);
    lines.push({
      rel: r.rel,
      size: r.size,
      infoHash: r.infoHash,
      magnet,
      path,
      torrentSize: r.encoded.length,
    });
    totalBytes += r.size;
    totalTorrentBytes += r.encoded.length;
    console.log(`  → ${path}  (${(r.encoded.length / 1024).toFixed(1)} KiB)`);
    console.log(`    ${magnet}`);
  }

  // 汇总一份磁力清单，方便直接贴进 QQ 群或写进 Release 说明。
  const manifest = lines.map((l) => `${l.rel}\t${l.size}\t${l.magnet}`).join('\n');
  writeFileSync(join(outDir, 'MAGNETS.txt'), `${manifest}\n`);

  console.log('');
  console.log(`共 ${lines.length} 个产物，总大小 ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log(
    `种子总大小 ${(totalTorrentBytes / 1024).toFixed(1)} KiB，清单 ${join(outDir, 'MAGNETS.txt')}`,
  );

  // 给 CI 用的 key=value 输出；本地跑时这些行也方便直接 eyeball。
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `file_count=${lines.length}`,
        `total_bytes=${totalBytes}`,
        `torrent_total_bytes=${totalTorrentBytes}`,
        `magnets_file=${join(outDir, 'MAGNETS.txt')}`,
        // 多行输出：第一行给消息用，完整清单走 MAGNETS.txt。
        'magnets<<MAGNETS_EOF',
        ...lines.map((l) => `- ${l.rel}`),
        'MAGNETS_EOF',
        '',
      ].join('\n'),
    );
  }
}
