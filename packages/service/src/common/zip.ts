/**
 * 最小二进制格式读取器（zip 中央目录 + sfnt 字体头校验）。
 *
 * 为什么 zip 要读**中央目录**而不是本地文件头：QQ 表情 / 装扮 CDN 的包时有流式
 * 压出来的（置了 data descriptor 标志，flag bit 3），本地头里的压缩/解压尺寸全是 0，
 * 真实尺寸写在数据之后。照本地头扫法会解出 0 字节或错位的垃圾数据 —— 字体包踩过
 * 这个坑：ttf 文件能落盘、体积看着正常，但内容错位，送进 Chromium 后 OTS 校验直接
 * 拒绝（`head: Failed to parse table`）。
 *
 * 这里从尾部的 EOCD 定位中央目录，按中央目录里的权威尺寸取数据 —— 这也是 zip
 * 规范要求的正确读法。只支持 store(0) 与 deflate(8)，够用且没有加密分支。
 */

import { inflateRawSync } from 'node:zlib';

/** zip 里的一个文件条目（已解压）。 */
export interface ZipEntry {
  /** 条目路径，形如 `358/apng/358.png`（分隔符统一为 `/`）。 */
  name: string;
  data: Buffer;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const EOCD_MIN_SIZE = 22;
/** EOCD 后面可跟最多 64KB 注释，只需回扫这么远。 */
const EOCD_SEARCH_LIMIT = 0xffff + EOCD_MIN_SIZE;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * 解出 zip 里的全部文件条目。目录条目会被跳过；遇到不支持的压缩方法或越界偏移
 * 时跳过该条目而不是整包失败。zip 本身不可解析（无 EOCD）时返回空数组。
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEocd(zip);
  if (eocd < 0) return [];

  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== SIG_CENTRAL) break;

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf-8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (localOffset + 30 > zip.length) continue;

    // 本地头的 name/extra 长度可能与中央目录不同（extra 常见差异），必须重读。
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) continue;

    const raw = zip.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === METHOD_STORE) {
      data = Buffer.from(raw);
    } else if (method === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(raw);
      } catch {
        continue;
      }
    } else {
      continue;
    }
    if (data.length !== uncompressedSize) continue;

    entries.push({ name: name.replace(/\\/g, '/'), data });
  }

  return entries;
}

/** 从尾部回扫 EOCD 记录的偏移；找不到返回 -1。 */
function findEocd(zip: Buffer): number {
  const start = Math.max(0, zip.length - EOCD_SEARCH_LIMIT);
  for (let i = zip.length - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (zip.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 从 zip 里解出第一个满足 `match` 的文件。
 *
 * 委托给 {@link readZipEntries}。返回 null 表示包里没有满足条件的条目。
 */
export function extractFromZip(zip: Buffer, match: (name: string) => boolean): Buffer | null {
  return readZipEntries(zip).find((e) => match(e.name))?.data ?? null;
}

/**
 * 同 {@link extractFromZip}，但收集**全部**满足 `match` 的条目而不是命中第一个就
 * 返回 —— 气泡整泡帧动画是几十个独立 PNG，没法复用「只找一个」的那个函数。
 */
export function extractAllFromZip(zip: Buffer, match: (name: string) => boolean): ZipEntry[] {
  return readZipEntries(zip).filter((e) => match(e.name));
}

/** 从字体包里解出 ttf。 */
export function extractFirstTtf(zip: Buffer): Buffer | null {
  return extractFromZip(zip, (n) => /\.ttf$/i.test(n));
}

/**
 * 校验一份 ttf 是否是能直接喂给浏览器的标准 sfnt。
 *
 * 装扮字体库里混杂着少数「内容保护」款（实测 itemId 20125、20563 都是）：zip 解压
 * 完全正确、sfnt 头和 table 目录的 checksum/searchRange 都对得上，但 `glyf` 表只是
 * 4 字节的桩，真正的轮廓数据被塞进两张私有表 `FTFG`/`FTFH`，并把标准里恒为 0 的
 * `head.glyphDataFormat` 改写成了 ASCII "FT"（0x4654）当自己的格式标记。这不是
 * OTS（Chromium 的字体安全校验）认识的 TrueType，送进 `@font-face` 会在解析 head 表
 * 那步直接被拒（`OTS parsing error: head: Failed to parse table`）——控制台看到的
 * 「Failed to decode downloaded font」就是这么来的，不是下载/网络问题。
 *
 * QQ 官方客户端显然认得这种私有格式（有自己的解码器），这边没有对应的解压算法，
 * 只能识别出来当「装不了」处理，别让这类文件流到渲染层。
 */
export function isRenderableSfnt(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const version = buf.readUInt32BE(0);
  // 0x00010000 = TrueType outlines,'OTTO' = CFF outlines,'true'/'typ1' 是老 mac 变体。
  if (![0x00010000, 0x4f54544f, 0x74727565, 0x74797031].includes(version)) return false;
  const numTables = buf.readUInt16BE(4);
  if (numTables === 0 || numTables > 128) return false;
  const dirEnd = 12 + numTables * 16;
  if (buf.length < dirEnd) return false;
  for (let i = 0; i < numTables; i += 1) {
    const off = 12 + i * 16;
    if (buf.toString('latin1', off, off + 4) !== 'head') continue;
    const tableOffset = buf.readUInt32BE(off + 8);
    const tableLength = buf.readUInt32BE(off + 12);
    if (tableLength < 54 || tableOffset + 54 > buf.length) return false;
    return buf.readUInt16BE(tableOffset + 52) === 0; // glyphDataFormat,标准恒为 0
  }
  return false; // 没有 head 表,肯定不是能渲染的字体
}
