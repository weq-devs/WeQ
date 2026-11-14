import { describe, expect, it, vi } from 'vitest';
import { getProfileSimilarity } from '../src/oidb/profile/similarity';
import { encode, decode, message } from '../src/protobuf';
import { legacyOidbEnvelope, LegacyOidbRejectedError } from '../src/oidb/legacy';

const identity = Buffer.from('08914e10924e', 'hex');
const wording = message([{ name: 'text', tag: 3, type: 'bytes' }]);
const records = message([{ name: 'items', tag: 14, type: wording, repeated: true }]);
function body(texts: string[]) {
  return Buffer.concat([
    identity,
    encode(records, { items: texts.map((text) => ({ text: Buffer.from(text) })) }),
  ]);
}
function binding(bytes: Uint8Array, result = 0, command = 0xcf4) {
  return {
    sendPacket: vi.fn(async () =>
      Buffer.from(encode(legacyOidbEnvelope, { command, serviceType: 0, result, body: bytes })),
    ),
  };
}
describe('QQ 共同资料独立读取', () => {
  it('首个且唯一请求为 0xcf4，手写 wire 正对照保留服务器原文', async () => {
    const nt = binding(Buffer.from('08914e10924e720b1a0973616d652063697479', 'hex'));
    expect(await getProfileSimilarity(nt, 7, '10001', '10002')).toEqual({
      targetUin: '10002',
      source: 'dna',
      items: [{ icon: null, title: '', wordings: ['same city'] }],
    });
    expect(nt.sendPacket).toHaveBeenCalledOnce();
    const call = nt.sendPacket.mock.calls[0] as unknown as [number, string, Buffer];
    expect(call.slice(0, 2)).toEqual([7, 'OidbSvc.0xcf4']);
    const request = decode(legacyOidbEnvelope, call[2]);
    expect(request).toMatchObject({ command: 0xcf4, serviceType: 0 });
    expect(Buffer.from(request.body as Uint8Array).toString('hex')).toBe('08914e10924e20013000');
  });
  it('只去重相同非空文案，不改写属性对照，也不引入新 DNA 小结', async () => {
    const text = '我在甲地，好友在乙地';
    const nt = binding(
      Buffer.concat([body([text, ' ', text, ' 原文保留 ']), Buffer.from('aa0100', 'hex')]),
    );
    expect((await getProfileSimilarity(nt, 7, '10001', '10002')).items).toEqual([
      { icon: null, title: '', wordings: [text, ' 原文保留 '] },
    ]);
  });
  it('双方身份有效的成功空响应与全空白文案返回空列表', async () => {
    for (const bytes of [identity, body(['', ' '])])
      expect(await getProfileSimilarity(binding(bytes), 7, '10001', '10002')).toEqual({
        targetUin: '10002',
        source: 'dna',
        items: [],
      });
  });
  it.each(['08934e10924e', '08914e10934e', '08914e', '10924e', ''])(
    '双方身份错误或缺失时拒绝，不转向聚合：%s',
    async (hex) => {
      const nt = binding(Buffer.from(hex, 'hex'));
      await expect(getProfileSimilarity(nt, 7, '10001', '10002')).rejects.toThrow('匹配');
      expect(nt.sendPacket).toHaveBeenCalledOnce();
    },
  );
  it.each([1, 151, 316])('业务拒绝 %i 保留实际结果且不发送第二个请求', async (result) => {
    const nt = binding(Buffer.alloc(0), result);
    const task = getProfileSimilarity(nt, 7, '10001', '10002');
    await expect(task).rejects.toBeInstanceOf(LegacyOidbRejectedError);
    await expect(task).rejects.toMatchObject({ result });
    expect(nt.sendPacket).toHaveBeenCalledOnce();
  });
  it('传输失败直接返回，不调用任何其他业务', async () => {
    const error = new Error('合成传输失败');
    const nt = {
      sendPacket: vi.fn(async () => {
        throw error;
      }),
    };
    await expect(getProfileSimilarity(nt, 7, '10001', '10002')).rejects.toBe(error);
    expect(nt.sendPacket).toHaveBeenCalledOnce();
  });
  it('拒绝错命令、截断和损坏 UTF-8，不降级为空', async () => {
    for (const nt of [
      binding(identity, 0, 0xcf5),
      binding(Buffer.concat([identity, Buffer.from('72031a02ff', 'hex')])),
      binding(Buffer.from('08914e10924e72031a01ff', 'hex')),
    ]) {
      await expect(getProfileSimilarity(nt, 7, '10001', '10002')).rejects.toThrow();
      expect(nt.sendPacket).toHaveBeenCalledOnce();
    }
  });
  it('限制条目数量与单条文案长度，边界值仍可读取', async () => {
    for (const bytes of [body(Array(101).fill('a')), body(['a'.repeat(65537)])])
      await expect(getProfileSimilarity(binding(bytes), 7, '10001', '10002')).rejects.toThrow(
        '无效',
      );
    const text = 'a'.repeat(65536);
    expect(
      (await getProfileSimilarity(binding(body([text])), 7, '10001', '10002')).items[0]?.wordings,
    ).toEqual([text]);
  });
  it.each([
    ['10001', '10001'],
    ['bad', '10002'],
    ['10001', 'bad'],
  ])('无效目标在发包前拒绝：%s / %s', async (self, target) => {
    const nt = binding(identity);
    await expect(getProfileSimilarity(nt, 7, self, target)).rejects.toThrow();
    expect(nt.sendPacket).not.toHaveBeenCalled();
  });
});
