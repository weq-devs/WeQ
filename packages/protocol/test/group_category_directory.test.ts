import { describe, expect, it } from 'vitest';
import { GetGroupCategoryTags } from '../src/index';

async function read(hex: string) {
  return GetGroupCategoryTags.invoke({ sendOidbPacket: async () => Buffer.from(hex, 'hex') }, 1, {
    groupClass: 37,
  });
}

describe('分类目录保留真实身份及帧边界', () => {
  it('只返回名称时不制造零ID或零类型', async () => {
    expect(await read('0a051203746167')).toEqual([{ id: null, name: 'tag', type: null }]);
  });
  it('显式零字段与字段未返回不同', async () => {
    expect(await read('0a09080012037461671800')).toEqual([{ id: 0, name: 'tag', type: 0 }]);
  });
  it('合法多字节名称与uint32上界不被误拒绝', async () => {
    expect(await read('0a081206e6a087e7adbe')).toEqual([{ id: null, name: '标签', type: null }]);
    expect(await read('0a0b08ffffffff0f1203746167')).toEqual([
      { id: 0xffffffff, name: 'tag', type: null },
    ]);
  });
  it('同名目录项保留，不擅自推断名称唯一或丢掉服务器记录', async () => {
    expect(await read('0a0512037461670a051203746167')).toEqual([
      { id: null, name: 'tag', type: null },
      { id: null, name: 'tag', type: null },
    ]);
  });
  it('未知合法字段不阻断已知目录，名称中的字节不作为嵌套protobuf解析', async () => {
    expect(await read('9003010a051203746167')).toEqual([{ id: null, name: 'tag', type: null }]);
    expect(await read('')).toEqual([]);
  });
  it.each([
    '0a061203746167',
    '0a051204746167',
    '0a',
    '0a80',
    '00',
    '0801',
    '0a0712037461671a00',
    '0a0b0880808080101203746167',
    '0a09080108021203746167',
    '0a031201ff',
    '0a020800',
    '0a021200',
    '950300',
    '0a0a12037461671203746167',
  ])('损坏、错误wire、整数溢出、重复字段或无效名称拒绝 %s', async (hex) => {
    await expect(read(hex)).rejects.toThrow();
  });
});
