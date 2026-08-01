/**
 * 最小 zip 读取器（走中央目录）。
 *
 * `dress_install.ts` 里已有一个 `extractFromZip`，但它扫本地文件头
 * (`PK\x03\x04`) 取 `compressedSize`。表情 CDN 的包是流式压出来的，置了
 * **data descriptor 标志（flag bit 3）**：本地头里的压缩/解压尺寸全是 0，真实
 * 尺寸写在数据之后。照那个扫法会解出 0 字节。
 *
 * 所以这里从尾部的 EOCD 定位中央目录，按中央目录里的权威尺寸取数据 —— 这也是
 * zip 规范要求的正确读法。只支持 store(0) 与 deflate(8)，够用且没有加密分支。
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
