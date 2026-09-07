/**
 * zip 中央目录读取器 + sfnt 字体校验的单测。测试内手工拼 zip 字节流（store /
 * deflate / EOCD 后带注释），把「必须读中央目录而不是本地头」这个踩坑约定钉死。
 */

import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  extractAllFromZip,
  extractFirstTtf,
  extractFromZip,
  isRenderableSfnt,
  readZipEntries,
} from '../src/common/zip';

// ---- 手工 zip 构造（store + deflate，含中央目录） ----

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}

interface RawEntry {
  name: string;
  data: Buffer;
  method: 0 | 8;
}

/** 拼一个最小合法 zip：本地头 + 数据 + 中央目录 + EOCD（可带注释）。 */
function buildZip(entries: RawEntry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8');
    const stored = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(e.method),
      u16(0),
      u16(0), // time/date
      u32(0), // crc（读侧不校验）
      u32(stored.length),
      u32(e.data.length),
      u16(name.length),
      u16(0), // extra len
      name,
      stored,
    ]);
    locals.push(local);

    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(e.method),
        u16(0),
        u16(0),
        u32(0),
        u32(stored.length),
        u32(e.data.length),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(comment.length),
    Buffer.from(comment, 'utf-8'),
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---- sfnt 最小 TrueType：head 表 glyphDataFormat 恒 0（可渲染） ----

function buildSfnt(
  glyphDataFormat = 0,
  opts: { noHead?: boolean; stubTables?: number } = {},
): Buffer {
  const numTables = opts.stubTables ?? 2;
  const dirEnd = 12 + numTables * 16;
  const headOff = opts.noHead ? null : dirEnd; // head 紧跟目录
  const head = Buffer.alloc(54);
  if (headOff != null) head.writeUInt16BE(glyphDataFormat, 52);
  return Buffer.concat([
    (() => {
      const v = Buffer.alloc(4);
      v.writeUInt32BE(0x00010000, 0);
      return v;
    })(),
    u16(numTables).swap16(), // BE
    Buffer.alloc(6),
    // 目录项：tag, checksum, offset, length
    ...Array.from({ length: numTables }, (_, i) =>
      i === 0 && headOff != null
        ? Buffer.concat([
            Buffer.from('head'),
            Buffer.alloc(4),
            u32(headOff).swap32(),
            u32(54).swap32(),
          ])
        : Buffer.concat([Buffer.from(`t${i}xx`), Buffer.alloc(12)]),
    ),
    ...(headOff != null ? [head] : []),
  ]);
}

describe('readZipEntries', () => {
  it('store 条目原样解出', () => {
    const zip = buildZip([{ name: 'a/b.txt', data: Buffer.from('hello'), method: 0 }]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('a/b.txt');
    expect(entries[0]!.data.toString()).toBe('hello');
  });

  it('deflate 条目正确解压', () => {
    const data = Buffer.from('deflate me '.repeat(20));
    const zip = buildZip([{ name: 'x.bin', data, method: 8 }]);
    expect(readZipEntries(zip)[0]!.data).toEqual(data);
  });

  it('EOCD 后带注释仍能定位（注释回扫）', () => {
    const zip = buildZip(
      [{ name: 'a.txt', data: Buffer.from('hi'), method: 0 }],
      'trailing comment ~',
    );
    expect(readZipEntries(zip)[0]!.data.toString()).toBe('hi');
  });

  it('目录条目（名字以 / 结尾）被跳过', () => {
    const zip = buildZip([
      { name: 'dir/', data: Buffer.alloc(0), method: 0 },
      { name: 'dir/f.txt', data: Buffer.from('f'), method: 0 },
    ]);
    expect(readZipEntries(zip).map((e) => e.name)).toEqual(['dir/f.txt']);
  });

  it.each([
    ['空 buffer', Buffer.alloc(0)],
    ['无 EOCD 的垃圾', Buffer.from('not a zip at all')],
  ])('%s → 空数组（不抛）', (_label, junk) => {
    expect(readZipEntries(junk)).toEqual([]);
  });

  it('中央目录里不支持的压缩方法：跳过该条目而不是整包失败', () => {
    const zip = buildZip([
      { name: 'good.txt', data: Buffer.from('g'), method: 0 },
      { name: 'bad.txt', data: Buffer.from('b'), method: 0 },
    ]);
    // 把第二个条目中央目录的 method 改成 99（bzip2，不支持）
    const eocdSearch = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let off = zip.readUInt32LE(eocdSearch + 16);
    off += 46 + 8; // 第二个中央头的 nameLen 是 8（"bad.txt"）
    zip.writeUInt16LE(99, off + 10);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['good.txt']);
  });
});

describe('extract helpers', () => {
  const zip = buildZip([
    { name: 'font/main.ttf', data: Buffer.from('TTF'), method: 8 },
    { name: 'frames/1.png', data: Buffer.from('p1'), method: 0 },
    { name: 'frames/2.png', data: Buffer.from('p2'), method: 0 },
  ]);

  it('extractFromZip 命中第一个满足条件的', () => {
    expect(extractFromZip(zip, (n) => n.endsWith('.png'))?.toString()).toBe('p1');
  });

  it('extractFromZip 未命中 → null', () => {
    expect(extractFromZip(zip, (n) => n.endsWith('.zip'))).toBeNull();
  });

  it('extractAllFromZip 收集全部命中', () => {
    const all = extractAllFromZip(zip, (n) => n.endsWith('.png'));
    expect(all.map((e) => e.data.toString())).toEqual(['p1', 'p2']);
  });

  it('extractFirstTtf 找 ttf', () => {
    expect(extractFirstTtf(zip)?.toString()).toBe('TTF');
  });
});

describe('isRenderableSfnt', () => {
  it('标准 TrueType（glyphDataFormat=0）→ true', () => {
    expect(isRenderableSfnt(buildSfnt(0))).toBe(true);
  });

  it.each([
    ['内容保护款：glyphDataFormat 被改成 "FT"', buildSfnt(0x4654)],
    ['没有 head 表', buildSfnt(0, { noHead: true })],
    ['版本魔数不认识', Buffer.from('RIFFxxxx', 'latin1')],
    ['太短', Buffer.alloc(8)],
  ])('%s → false', (_label, buf) => {
    expect(isRenderableSfnt(buf)).toBe(false);
  });
});
