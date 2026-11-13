import assert from 'node:assert/strict';
import { open, type FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, gzip, gunzip } from 'node:zlib';

export type ArchiveFormat = 'json' | 'jsonl' | 'jsonl.gz';
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const limit = 65 * 1024 * 1024;
const headerSize = 22;

/** 标准 gzip FEXTRA 的 WQ 子字段记录成员长度，解压后仍是普通 JSONL。 */
export async function compressArchiveBlock(text: string | Buffer): Promise<Buffer> {
  assert(Buffer.byteLength(text) <= limit, '压缩归档单块超过 65 MiB');
  const data = await compress(text);
  const header = Buffer.alloc(headerSize);
  data.copy(header, 0, 0, 10);
  header[3] = 6;
  header.writeUInt16LE(8, 10);
  header.write('WQ', 12, 'ascii');
  header.writeUInt16LE(4, 14);
  header.writeUInt32LE(data.length + 12, 16);
  header.writeUInt16LE(crc32(header.subarray(0, 20)) & 0xffff, 20);
  return Buffer.concat([header, data.subarray(10)]);
}

export function compressedArchiveWriter(file: FileHandle) {
  let chunks: string[] = [],
    bytes = 0;
  return {
    async write(text: string) {
      bytes += Buffer.byteLength(text);
      assert(bytes <= limit, '压缩归档单块超过 65 MiB');
      chunks.push(text);
    },
    async flush() {
      if (!bytes) return;
      await file.writeFile(await compressArchiveBlock(chunks.join('')));
      chunks = [];
      bytes = 0;
    },
  };
}

/** 每次只展开一个成员；截断尾成员不生效，完整成员的 CRC 错误必须报告。 */
export async function* compressedArchiveBlocks(
  path: string,
  signal?: AbortSignal,
  range?: { start: number; end: number },
) {
  const file = await open(path, 'r');
  try {
    const size = Math.min((await file.stat()).size, range?.end ?? Infinity);
    let position = range?.start ?? 0;
    const read = async (buffer: Buffer, at: number) => {
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, at + offset);
        assert(bytesRead > 0, '压缩归档在读取时被截断');
        offset += bytesRead;
      }
    };
    while (position + headerSize <= size) {
      signal?.throwIfAborted();
      const header = Buffer.alloc(headerSize);
      await read(header, position);
      assert(
        header.subarray(0, 4).equals(Buffer.from([31, 139, 8, 6])) &&
          header.readUInt16LE(10) === 8 &&
          header.toString('ascii', 12, 14) === 'WQ' &&
          header.readUInt16LE(14) === 4,
        '不是 WeQ 分块压缩 JSONL',
      );
      assert(
        header.readUInt16LE(20) === (crc32(header.subarray(0, 20)) & 0xffff),
        '压缩归档块头校验失败',
      );
      const length = header.readUInt32LE(16);
      assert(length >= headerSize + 8 && length <= limit + 65536, '压缩归档块长度无效');
      if (position + length > size) return;
      const block = Buffer.alloc(length);
      header.copy(block);
      await read(block.subarray(headerSize), position + headerSize);
      const data = await decompress(block, { maxOutputLength: limit });
      signal?.throwIfAborted();
      const start = position;
      position += length;
      yield { data, start, end: position };
    }
  } finally {
    await file.close();
  }
}
