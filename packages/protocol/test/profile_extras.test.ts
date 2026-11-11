import { describe, expect, it, vi } from 'vitest';
import {
  decode,
  message,
  getSignatureHistory,
  getProfileEnergy,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
  parseRichStatus,
  decodeProfileCursor,
} from '../src/index';

// 独立构造原始 wire，不用生产响应 schema 生成样本。
function v(n: number | bigint) {
  let value = BigInt(n);
  const bytes: number[] = [];
  do {
    bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Buffer.from(bytes);
}
function n(tag: number, value: number | bigint) {
  return Buffer.concat([v(tag * 8), v(value)]);
}
function b(tag: number, value: Uint8Array | string | number[]) {
  const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([v(tag * 8 + 2), v(data.length), data]);
}
function pb(...fields: Uint8Array[]) {
  return Buffer.concat(fields);
}
function oidb(command: number, sub: number, body: Uint8Array, result = 0) {
  return pb(n(1, command), n(2, sub), n(3, result), b(4, body));
}
const nt = (reply: Uint8Array) => ({
  sendPacket: vi.fn(async (_pid: number, _command: string, _body: Uint8Array) =>
    Buffer.from(reply),
  ),
});
function web(value: unknown, ret = 0) {
  return pb(n(2, 0), n(3, ret), b(4, JSON.stringify(value)));
}

describe('资料扩展协议', () => {
  it('能量趋势保留有符号值', async () => {
    expect(
      await getProfileEnergy(nt(b(1, pb(n(8, 10002), n(3, 0xffffffffffffffffn)))), 5, '10002'),
    ).toMatchObject({ trend: -1 });
  });
  it('问答拒绝不可显示的时间与精度已经丢失的计数', async () => {
    for (const fields of [
      { uint64_time: Number.MAX_SAFE_INTEGER },
      { uint64_praise_num: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(
        getAnonymousQuestions(
          nt(
            web({
              ErrorCode: 0,
              bool_is_fetch_over: true,
              msg_quest: [{ str_id: 'a', ...fields }],
            }),
          ),
          5,
          '10002',
          'all',
        ),
      ).rejects.toThrow();
    }
  });
  it('签名 TLV 区分正文、动作、地点并忽略二进制属性', () => {
    expect(
      parseRichStatus(Buffer.from([3, 2, 104, 105, 1, 1, 97, 2, 1, 98, 4, 1, 99, 129, 1, 255])),
    ).toEqual({ text: 'hi', action: 'a', data: 'b', location: 'c' });
  });
  it.each([[3], [3, 3, 65], [3, 1, 255]])('拒绝截断或非法 UTF-8 签名 %j', (value) =>
    expect(() => parseRichStatus(Buffer.from(value))).toThrow(),
  );
  it('签名请求使用稀疏 tag，下一页移动时间上界', async () => {
    const transport = nt(
      oidb(0xde8, 1, pb(b(1, pb(b(1, 'feed'), b(2, [3, 2, 111, 107]), n(4, 100))), n(2, 0))),
    );
    const result = await getSignatureHistory(transport, 5, '10002', 200);
    expect(result.items[0]).toMatchObject({ text: 'ok', createdAt: 100 });
    expect(result.nextCursor).toBe(99);
    const envelope = decode(
      message([{ name: 'body', tag: 4, type: 'bytes' }]),
      transport.sendPacket.mock.calls[0]![2],
    );
    const request = decode(
      message(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((tag) => ({
          name: String(tag),
          tag,
          type: 'uint64' as const,
        })),
      ),
      envelope.body as Uint8Array,
    );
    expect(request).toMatchObject({
      1: 10002n,
      2: 2n,
      4: 0n,
      5: 200n,
      6: 0n,
      7: 0n,
      8: 6n,
      10: 60n,
    });
    expect(request[3]).toBeUndefined();
    expect(request[9]).toBeUndefined();
    expect(transport.sendPacket.mock.calls[0]![1]).toBe('OidbSvc.0xde8_1');
  });
  it('签名结束空页是成功而非错误', async () =>
    expect(await getSignatureHistory(nt(oidb(0xde8, 1, n(2, 1))), 5, '10002')).toMatchObject({
      items: [],
      hasMore: false,
      paginationError: null,
    }));
  it('空签名非结束页保留结果并报告缺游标', async () =>
    expect(await getSignatureHistory(nt(oidb(0xde8, 1, n(2, 0))), 5, '10002')).toMatchObject({
      items: [],
      hasMore: false,
      paginationError: expect.any(String),
    }));
  it('拒绝旧 OIDB 错误或命令错配', async () => {
    await expect(
      getSignatureHistory(nt(oidb(0xde8, 1, n(2, 1), 151)), 5, '10002'),
    ).rejects.toThrow();
    await expect(getSignatureHistory(nt(oidb(0x8f0, 0, n(2, 1))), 5, '10002')).rejects.toThrow();
  });
  it('能量值校验回显，缺失与零不同；tag 8 是 UIN', async () => {
    const transport = nt(b(1, pb(n(1, 0), n(8, 10002))));
    expect(await getProfileEnergy(transport, 5, '10002')).toEqual({
      targetUin: '10002',
      score: 0,
      level: null,
      trend: null,
      display: null,
    });
    expect(transport.sendPacket.mock.calls[0]![1]).toBe('qqvalue.GetQQValue');
    await expect(getProfileEnergy(nt(b(1, n(8, 10003))), 5, '10002')).rejects.toThrow('目标');
    await expect(getProfileEnergy(nt(b(1, n(1, 2))), 5, '10002')).rejects.toThrow('目标');
  });
  it('标签照片的 URL 是 string，大整数 ID 不损失精度', async () => {
    const photo = pb(n(1, 9007199254740993n), b(2, 'https://p.qpic.cn/example'), n(3, 100));
    const label = pb(n(2, 12), b(4, '旅行'), n(9, 9), b(10, photo), b(11, [0, 0, 0, 5]));
    const result = await getPersonalityLabels(
      nt(oidb(0x8f0, 0, pb(b(1, label), n(4, 9)))),
      5,
      '10002',
    );
    expect(result.labels[0]?.photos[0]).toMatchObject({
      id: '9007199254740993',
      url: 'https://p.qpic.cn/example',
    });
    expect(result.labels[0]?.photoCursor).toBe('AAAABQ==');
  });
  it('相册结束页可省略 cookie 和照片', async () => {
    expect(
      await getPersonalityPhotos(nt(oidb(0x8f1, 0, n(2, 1))), 5, '10002', '12', 'AAAABQ=='),
    ).toMatchObject({ items: [], hasMore: false, paginationError: null });
  });
  it('相册重复游标不丢当前页，停止自动续页', async () => {
    const result = await getPersonalityPhotos(
      nt(oidb(0x8f1, 0, pb(n(2, 0), b(3, [0, 0, 0, 5])))),
      5,
      '10002',
      '12',
      'AAAABQ==',
    );
    expect(result).toMatchObject({
      hasMore: false,
      nextCursor: null,
      paginationError: expect.any(String),
    });
  });
  it.each(['?', 'AAA', 'AA=A', '====', ''])('拒绝非规范二进制游标 %s', (value) =>
    expect(() => decodeProfileCursor(value)).toThrow(),
  );
  it('问答使用 JSON WebSSO，少于请求量仍能翻页，不暴露 answered 总数', async () => {
    const transport = nt(
      web({
        ErrorCode: 0,
        uint32_ret: 0,
        msg_quest: [
          {
            str_id: 'a',
            str_quest: '问题',
            str_ans: '回答',
            uint64_praise_num: '9007199254740993',
          },
        ],
        bool_is_fetch_over: false,
        bytes_cookie: 'next',
        uint32_answered_quest_num: 2,
      }),
    );
    const result = await getAnonymousQuestions(transport, 5, '10002', 'answered');
    expect(result).toMatchObject({
      hasMore: true,
      nextCursor: 'next',
      items: [{ id: 'a', likes: '9007199254740993' }],
    });
    expect(result).not.toHaveProperty('answeredCount');
    const body = decode(
      message([
        { name: 'type', tag: 2, type: 'uint32' },
        { name: 'data', tag: 3, type: 'string' },
      ]),
      transport.sendPacket.mock.calls[0]![2],
    );
    expect(body.type).toBe(0);
    expect(JSON.parse(body.data as string)).toMatchObject({
      uint64_uin: 10002,
      uint64_quest_num: 10,
      uint64_comment_num: 10,
      uint32_fetch_type: 1,
    });
  });
  it.each([
    web({ ErrorCode: 1 }),
    web({ ErrorCode: 0 }, 1),
    web({ ErrorCode: 0, uint32_ret: 1 }),
    web({ ErrorCode: 0 }),
  ])('问答传输／业务错误或缺结束标记不当作空结果', async (reply) => {
    await expect(getAnonymousQuestions(nt(reply), 5, '10002', 'all')).rejects.toThrow();
  });
  it('问答空的已结束响应成功', async () =>
    expect(
      await getAnonymousQuestions(
        nt(web({ ErrorCode: 0, msg_quest: [], bool_is_fetch_over: true })),
        5,
        '10002',
        'all',
      ),
    ).toMatchObject({ items: [], hasMore: false }));
});
