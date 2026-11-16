import { describe, expect, it } from 'vitest';
import { decode, encode, message } from '../src/protobuf';
import { SetQzoneFeedStatus } from '../src/qzone/feed-status';

const request = message([
  { name: 'id', tag: 1, type: 'string' },
  {
    name: 'status',
    tag: 2,
    type: message([
      { name: 'kind', tag: 1, type: 'int32' },
      { name: 'action', tag: 2, type: 'uint32' },
    ]),
    repeated: true,
  },
  { name: 'owner', tag: 3, type: 'string' },
  { name: 'actor', tag: 4, type: 'string' },
]);
const response = message([
  { name: 'outerCode', tag: 2, type: 'uint64' },
  {
    name: 'body',
    tag: 4,
    type: message([
      { name: 'code', tag: 1, type: 'int32', force: true },
      { name: 'msg', tag: 2, type: 'string' },
    ]),
  },
]);
describe('普通说说投稿与收录写入', () => {
  it.each([
    ['contribute', 19, 1],
    ['uncontribute', 19, 2],
    ['unarchive', 6, 2],
  ] as const)('使用 SDK 字段发送 %s，不直接写 archiveStatus', (action, kind, value) => {
    const encoded = SetQzoneFeedStatus.serialize({ selfUin: '10001', feedId: 'native-id', action });
    expect(decode(request, encoded.body)).toEqual({
      id: 'native-id',
      owner: '10001',
      actor: '10001',
      status: [{ kind, action: value }],
    });
  });
  it('外层、业务错误与缺失回执均不视为成功', () => {
    expect(SetQzoneFeedStatus.parse(encode(response, { body: { code: 0 } }))).toEqual({
      accepted: true,
    });
    expect(() =>
      SetQzoneFeedStatus.parse(
        encode(response, { body: { code: 14001, msg: 'synthetic refusal' } }),
      ),
    ).toThrow('synthetic refusal');
    expect(() =>
      SetQzoneFeedStatus.parse(encode(response, { outerCode: 1n, body: { code: 0 } })),
    ).toThrow();
    expect(() => SetQzoneFeedStatus.parse(new Uint8Array())).toThrow();
  });
});
