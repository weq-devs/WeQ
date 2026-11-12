import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import type { TrpcNative } from '@weq/protocol';
import {
  QzoneLegacyService,
  qzoneReplyMention,
  resolveQzoneReplyTarget,
} from '../src/account/qzone_legacy';
import {
  decodeJce,
  encodeJce,
  fieldsOf,
  map,
  qzoneLegacyRequest,
  qzoneLegacyResponse,
  structure,
} from '../src/account/qzone_legacy_wire';

const self = '10001';
function response(key: string, fields: Parameters<typeof structure>[0], code = 0) {
  return encodeJce({
    0: 1,
    1: BigInt(self),
    2: 0,
    3: code,
    5: encodeJce({
      0: map([[key, map([['synthetic.response', encodeJce({ 0: structure(fields) })]])]]),
    }),
  });
}
function requestBody(packet: Uint8Array, key: string, type: string) {
  const outer = decodeJce(packet.subarray(4));
  const bytes = outer.get('8');
  if (!(bytes instanceof Uint8Array)) throw new Error('missing attributes');
  const attrs = fieldsOf(decodeJce(bytes).get('0'));
  const raw = fieldsOf(attrs.get(key)).get(type);
  if (!(raw instanceof Uint8Array)) throw new Error('missing body');
  return fieldsOf(decodeJce(raw).get('0'));
}
describe('空间旧原生协议', () => {
  it('从新读回的评论绑定父评论作者，不从渲染层相信伪造对象', () => {
    const root = { id: 'root', uin: '10002', nickname: 'Root', isReply: false };
    const reply = {
      id: 'reply',
      uin: '10003',
      nickname: 'Reply',
      isReply: true,
      parentCommentId: 'root',
    };
    expect(resolveQzoneReplyTarget([root, reply], 'reply')).toEqual({
      rootId: 'root',
      rootUin: '10002',
      targetUin: '10003',
      nickname: 'Reply',
    });
    expect(() => resolveQzoneReplyTarget([reply], 'reply')).toThrow('未取得');
    expect(() => resolveQzoneReplyTarget([root], 'missing')).toThrow('未取得');
  });
  it('JCE 整数和字符串使用固定黄金字节，独立解码保留负数', () => {
    expect(encodeJce({ 0: 0, 1: -1, 2: 128, 3: 'A' }).toString('hex')).toBe('0c10ff210080360141');
    expect(decodeJce(Uint8Array.from([0x00, 0xff])).get('0')).toBe(-1n);
  });
  it('拒绝不安全整数、超限整数、重复响应字段及截断报文', () => {
    expect(() => encodeJce({ 0: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => encodeJce({ 0: 1n << 64n })).toThrow();
    expect(() => decodeJce(Uint8Array.from([0x0c, 0x0c]))).toThrow('重复');
    expect(() => decodeJce(Uint8Array.from([0x07, 0, 0, 1]))).toThrow();
  });
  it('业务命令留在 QMF 内，并保留整包长度及带类型名的 UniAttribute', () => {
    const bytes = qzoneLegacyRequest(
      self,
      'getDeviceInfo',
      'NS_MOBILE_EXTRA.GetDeviceInfoReq',
      { 0: 10001n },
      5,
    );
    expect(bytes.readUInt32BE()).toBe(bytes.length);
    expect(decodeJce(bytes.subarray(4)).get('4')).toBe('QzoneNewService.getDeviceInfo');
    expect(requestBody(bytes, 'getDeviceInfo', 'NS_MOBILE_EXTRA.GetDeviceInfoReq').get('0')).toBe(
      10001n,
    );
  });
  it('缺失返回码、非零 WNS／业务状态和错误业务 key 均不能当成功', () => {
    expect(() => qzoneLegacyResponse(encodeJce({ 0: 1 }), 'addReply')).toThrow();
    expect(() => qzoneLegacyResponse(response('addReply', { 0: 0 }, 7), 'addReply')).toThrow(
      '业务 7',
    );
    expect(() => qzoneLegacyResponse(response('other', { 0: 0 }), 'addReply')).toThrow('目标业务');
    const denied = encodeJce({
      0: map([
        ['ret', map([['int32', encodeJce({ 0: -4001 })]])],
        ['msg', map([['string', encodeJce({ 0: 'synthetic rejection' })]])],
      ]),
    });
    expect(() => qzoneLegacyResponse(denied, 'addReply')).toThrow('-4001');
  });
  it('回复根评论与被回复者分离，只发送一次正确外层命令', async () => {
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () =>
      response('addReply', { 0: 0, 3: 'new-reply' }),
    );
    const service = new QzoneLegacyService({ sendPacket }, () => 10, self);
    await expect(
      service.reply('10002', 'post', 'body', {
        rootId: 'root',
        rootUin: '10003',
        targetUin: '10004',
        nickname: 'Target',
      }),
    ).resolves.toEqual({ id: 'new-reply' });
    expect(sendPacket).toHaveBeenCalledOnce();
    expect(sendPacket.mock.calls[0]?.[1]).toBe('SQQzoneSvc.addReply');
    const body = requestBody(
      sendPacket.mock.calls[0]![2]!,
      'addReply',
      'NS_MOBILE_OPERATION.operation_addreply_req',
    );
    expect(body.get('3')).toBe(10003n);
    expect(body.get('5')).toBe('root');
    expect(body.get('6')).toBe('@{uin:10004,nick:Target,who:1,auto:1}body');
  });
  it('超时不自动重发写入；回执有验证跳转也不当成功', async () => {
    const sendPacket = vi.fn().mockRejectedValue(new Error('timeout'));
    const service = new QzoneLegacyService({ sendPacket }, () => 10, self);
    await expect(service.forward('10002', 'post', '')).rejects.toThrow('timeout');
    expect(sendPacket).toHaveBeenCalledOnce();
    sendPacket.mockResolvedValue(response('forward', { 0: 0, 2: 'id', 3: 'verification' }));
    await expect(service.forward('10002', 'post', '')).rejects.toThrow('未确认');
  });
  it('按服务端压缩控制解压业务体，不把缺失结果补成成功', () => {
    const original = decodeJce(response('addReply', { 0: 0, 3: 'new-reply' })).get('5');
    if (!(original instanceof Uint8Array)) throw new Error('fixture body missing');
    const extra = encodeJce({
      0: map([
        [
          'busiCompCtl',
          map([['QMF_PROTOCAL.QmfBusiControl', encodeJce({ 0: structure({ 0: 1 }) })]]),
        ],
      ]),
    });
    const compressed = encodeJce({
      0: 1,
      1: BigInt(self),
      2: 0,
      3: 0,
      5: deflateSync(original),
      6: extra,
    });
    expect(qzoneLegacyResponse(compressed, 'addReply').get('3')).toBe('new-reply');
  });
  it('尾巴缺失选择状态保持未知，空标识可作为服务端的有效选项', async () => {
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () =>
      response('getDeviceInfo', {
        0: [structure({ 0: '', 3: '', 5: 1 }), structure({ 0: 'device', 3: 'key' })],
      }),
    );
    const service = new QzoneLegacyService({ sendPacket }, () => 10, self);
    expect(await service.tails()).toEqual([
      { id: '', label: '不展示', selected: true, editable: false },
      { id: 'key', label: 'device', selected: null, editable: false },
    ]);
  });
  it('尾巴设置重新核选项，不提交已经失效的选择', async () => {
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () =>
      response('getDeviceInfo', { 0: [] }),
    );
    await expect(
      new QzoneLegacyService({ sendPacket }, () => 10, self).setTail('stale'),
    ).rejects.toThrow('已变化');
    expect(sendPacket).toHaveBeenCalledOnce();
  });
  it('QQ PID 变化拒绝旧结果；提交前的账号校验失败不发包', async () => {
    let pid = 10;
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () => {
      pid = 11;
      return response('getDeviceInfo', { 0: [] });
    });
    await expect(new QzoneLegacyService({ sendPacket }, () => pid, self).tails()).rejects.toThrow(
      '已切换',
    );
    sendPacket.mockClear();
    await expect(
      new QzoneLegacyService({ sendPacket }, () => pid, self).forward('10002', 'post', '', () => {
        throw new Error('changed');
      }),
    ).rejects.toThrow('changed');
    expect(sendPacket).not.toHaveBeenCalled();
  });
  it('昵称转义及 Unicode 截短不混淆回复目标', () => {
    expect(qzoneReplyMention('10001', '%,{}:')).toBe(
      '@{uin:10001,nick:%25%2C%7B%7D%3A,who:1,auto:1}',
    );
    expect(qzoneReplyMention('10001', 'abcdefghijk')).toContain('abcdefghij...');
  });
});
