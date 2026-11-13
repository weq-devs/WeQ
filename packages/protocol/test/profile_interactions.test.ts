import { expect, it, vi } from 'vitest';
import {
  decode,
  message,
  getSignatureHistory,
  getSignatureLikes,
  setSignatureLike,
  addSignatureComment,
  deleteSignatureComment,
  getAnonymousQuestionDetail,
  getAnonymousComments,
  buildPersonalityPhotoExtend,
  parsePersonalityPhotoUpload,
  deletePersonalityPhoto,
} from '../src/index';

function v(n: number | bigint) {
  let value = BigInt(n);
  const bytes: number[] = [];
  do {
    bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0));
    value >>= 7n;
  } while (value);
  return Buffer.from(bytes);
}
const pb = (...fields: Uint8Array[]) => Buffer.concat(fields);
const n = (tag: number, value: number | bigint) => pb(v(tag * 8), v(value));
const b = (tag: number, value: Uint8Array | string) => {
  const bytes = Buffer.from(value);
  return pb(v(tag * 8 + 2), v(bytes.length), bytes);
};
const oidb = (cmd: number, sub: number, body: Uint8Array, result = 0) =>
  pb(n(1, cmd), n(2, sub), n(3, result), b(4, body));
const nt = (reply: Uint8Array) => ({
  sendPacket: vi.fn(async (_pid: number, _command: string, _body: Uint8Array) =>
    Buffer.from(reply),
  ),
});
const web = (value: unknown) => pb(n(2, 0), n(3, 0), b(4, JSON.stringify(value)));
const signature = { id: Buffer.from('real-feed').toString('hex'), createdAt: 123 };
function request(transport: ReturnType<typeof nt>, fields: Parameters<typeof message>[0]) {
  const call = transport.sendPacket.mock.calls[0]!;
  const outer = decode(message([{ name: 'body', tag: 4, type: 'bytes' }]), call[2]);
  return decode(message(fields), outer.body as Uint8Array);
}
it('签名历史保留回复与大整数赞数', async () => {
  const comment = pb(
    n(1, 9007199254740993n),
    b(2, '回复'),
    n(3, 22),
    n(4, 10003),
    n(5, 10002),
    n(6, 123),
  );
  const transport = nt(
    oidb(
      0xde8,
      1,
      pb(
        b(
          1,
          pb(
            b(1, 'real-feed'),
            b(2, Buffer.from([3, 1, 65])),
            n(4, 123),
            b(7, comment),
            b(8, pb(n(1, 9007199254740995n), b(2, pb(n(1, 10002), n(2, 120))))),
          ),
        ),
        n(2, 1),
      ),
    ),
  );
  expect((await getSignatureHistory(transport, 5, '10001')).items[0]).toMatchObject({
    likes: '9007199254740995',
    likeUsers: [{ uin: '10002' }],
    commentItems: [{ id: '9007199254740993', replyId: '22', toUin: '10003', fromUin: '10002' }],
  });
});
it('点赞取消显式发送零并恢复真实 feed 字节', async () => {
  const transport = nt(oidb(0x795, 0, n(1, 0)));
  await setSignatureLike(transport, 5, '10001', signature, false);
  const body = request(transport, [
    { name: 'feed', tag: 1, type: 'bytes' },
    { name: 'action', tag: 5, type: 'uint32' },
  ]);
  expect(Buffer.from(body.feed as Uint8Array).toString()).toBe('real-feed');
  expect(body.action).toBe(0);
});
it('新增与删除评论的 tag 3/4 不混淆', async () => {
  const add = nt(oidb(0xde5, 1, n(1, 9007199254740993n)));
  expect(await addSignatureComment(add, 5, '10001', '10002', signature.id, '内容', '22')).toBe(
    '9007199254740993',
  );
  const fields = [3, 4].map((tag) => ({ name: String(tag), tag, type: 'uint64' as const }));
  expect(request(add, fields)).toMatchObject({ 3: 22n, 4: 10002n });
  const del = nt(oidb(0xde7, 1, new Uint8Array()));
  await deleteSignatureComment(del, 5, '10001', '10002', signature.id, '9007199254740993');
  expect(request(del, fields)).toMatchObject({ 3: 10002n, 4: 9007199254740993n });
});
it('点赞分页 flag=0 结束且保留最后一页', async () => {
  const transport = nt(oidb(0x796, 0, pb(n(1, 0), b(3, pb(n(1, 10002), n(2, 120))), n(5, 0))));
  expect(await getSignatureLikes(transport, 5, '10001', signature)).toMatchObject({
    hasMore: false,
    items: [{ uin: '10002' }],
  });
});
it('问答详情与评论分页分别读取 cookie，保留末页与回复', async () => {
  const detail = await getAnonymousQuestionDetail(
    nt(
      web({
        ErrorCode: 0,
        msg_quest: {
          str_id: 'q1',
          rpt_praise: [{ uint64_from_uin: '10002', str_from_nick: '昵称' }],
        },
        strCommentCookie: 'next',
        int32_comment_fetch_over: 0,
      }),
    ),
    5,
    '10001',
    'q1',
    123,
  );
  expect(detail).toMatchObject({
    nextCursor: 'next',
    hasMore: true,
    likeUsers: [{ name: '昵称' }],
  });
  const result = await getAnonymousComments(
    nt(
      web({
        ErrorCode: 0,
        rpt_comment: [
          { str_id: 'c1', str_comment: '末页', uint64_from_uin: '10002', str_reply_id: 'c0' },
        ],
        int32_is_fetch_over: 1,
      }),
    ),
    5,
    '10001',
    'q1',
    'next',
  );
  expect(result).toMatchObject({
    hasMore: false,
    items: [{ id: 'c1', replyId: 'c0', text: '末页' }],
  });
});
it('照片扩展大端 28 字节，业务错误与截断均报错', () => {
  const ext = Buffer.from(buildPersonalityPhotoExtend('9007199254740993', 2, 1, 123));
  expect(ext.length).toBe(28);
  expect(ext.readBigUInt64BE()).toBe(9007199254740993n);
  expect([8, 12, 16, 20, 24].map((offset) => ext.readUInt32BE(offset))).toEqual([2, 1, 0, 0, 123]);
  const bytes = Buffer.alloc(17);
  bytes.writeBigUInt64BE(9007199254740993n, 5);
  bytes.writeUInt32BE(3, 13);
  expect(parsePersonalityPhotoUpload(pb(bytes, Buffer.from('url')))).toEqual({
    photoId: '9007199254740993',
    url: 'url',
  });
  expect(() => parsePersonalityPhotoUpload(Buffer.from([1]))).toThrow();
  expect(() => parsePersonalityPhotoUpload(bytes)).toThrow();
});
it('标签照片清理使用真实稀疏 tag 2/3/4', async () => {
  const transport = nt(oidb(0x90c, 0, new Uint8Array()));
  await deletePersonalityPhoto(transport, 5, '10001', '12', '9007199254740993');
  expect(
    request(transport, [
      { name: 'unused', tag: 1, type: 'uint64' },
      { name: 'uin', tag: 2, type: 'uint64' },
      { name: 'label', tag: 3, type: 'uint64' },
      { name: 'photos', tag: 4, type: 'uint64', repeated: true },
    ]),
  ).toEqual({ uin: 10001n, label: 12n, photos: [9007199254740993n] });
});
it('点赞缺页点或重复页点保留当前页并停止续页', async () => {
  for (const point of [new Uint8Array(), b(4, pb(n(1, 10002), n(2, 120)))]) {
    const result = await getSignatureLikes(
      nt(oidb(0x796, 0, pb(n(1, 0), b(3, pb(n(1, 10002), n(2, 120))), point, n(5, 1)))),
      5,
      '10001',
      signature,
      '10002:120',
    );
    expect(result).toMatchObject({
      items: [{ uin: '10002' }],
      hasMore: false,
      nextCursor: null,
      paginationError: expect.any(String),
    });
  }
});
it('签名与问答业务错误、目标错配和缺结束标记分别报错', async () => {
  await expect(
    setSignatureLike(nt(oidb(0x795, 0, n(1, 7))), 5, '10001', signature, true),
  ).rejects.toThrow('7');
  await expect(
    getSignatureLikes(nt(oidb(0x796, 0, n(1, 0), 151)), 5, '10001', signature),
  ).rejects.toThrow('151');
  await expect(
    getAnonymousQuestionDetail(
      nt(web({ ErrorCode: 0, msg_quest: { str_id: 'other' }, int32_comment_fetch_over: 1 })),
      5,
      '10001',
      'q1',
      123,
    ),
  ).rejects.toThrow('不匹配');
  await expect(getAnonymousComments(nt(web({ ErrorCode: 1 })), 5, '10001', 'q1')).rejects.toThrow();
  await expect(getAnonymousComments(nt(web({ ErrorCode: 0 })), 5, '10001', 'q1')).rejects.toThrow(
    '结束',
  );
});
it('无效 feed、回复数字和批次在发包前拒绝', async () => {
  const transport = nt(oidb(0xde5, 1, n(1, 1)));
  await expect(addSignatureComment(transport, 5, '10001', '10002', 'odd', '内容')).rejects.toThrow(
    '标识',
  );
  await expect(
    addSignatureComment(
      transport,
      5,
      '10001',
      '10002',
      signature.id,
      '内容',
      '18446744073709551616',
    ),
  ).rejects.toThrow('数字');
  expect(transport.sendPacket).not.toHaveBeenCalled();
  expect(() => buildPersonalityPhotoExtend('12', 2, 2, 123)).toThrow('批次');
  expect(Buffer.from(buildPersonalityPhotoExtend('12', 2, 0, 123)).readUInt32BE(12)).toBe(0);
});
