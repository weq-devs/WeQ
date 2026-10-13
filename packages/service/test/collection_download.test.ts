import { describe, expect, it, vi } from 'vitest';
import { ProtoMsg, ProtoField as P, ScalarType as S } from '@weq/codec';
import { decodeMessage } from '@weq/db';
import { CollectorFileInfo, CollectorRespHead } from '@weq/codec/proto/collection/index';
import { applyCollectionFileDownload } from '../src/account/web/collection_download';
import { encodeEnvelope, type CollectionHttpRequest } from '../src/account/web/collection';
const cred = { uin: '10001', skey: '', pskey: 'synthetic-account-ticket' };
const file = {
  src: 3,
  uid: 10001n,
  bid: 236,
  fid: 'synthetic-fid',
  name: '例子.txt',
  size: 7n,
  md5: new Uint8Array(16),
};
const head = {
  uin: P(1, S.UINT64, { optional: true }),
  sequence: P(2, S.UINT32, { optional: true }),
  command: P(3, S.UINT32, { optional: true }),
  operation: P(4, S.UINT32, { optional: true }),
  version: P(5, S.UINT32, { optional: true }),
  client: P(6, S.UINT32, { optional: true }),
  platform: P(7, S.UINT32, { optional: true }),
  ticketType: P(10, S.UINT32, { optional: true }),
  ticket: P(11, S.STRING, { optional: true }),
  f14: P(14, S.UINT32, { optional: true }),
  f15: P(15, S.UINT32, { optional: true }),
};
const req = {
  operation: P(
    1,
    () => ({
      apply: P(
        20014,
        () => ({
          cid: P(1, S.STRING, { optional: true }),
          file: P(2, () => CollectorFileInfo, { optional: true }),
          thumbnail: P(3, S.BOOL, { optional: true }),
        }),
        { optional: true },
      ),
    }),
    { optional: true },
  ),
};
const rsp = {
  operation: P(
    2,
    () => ({
      apply: P(
        20014,
        () => ({
          key: P(1, S.BYTES, { optional: true }),
          httpsHost: P(7, S.STRING, { optional: true }),
          httpsPort: P(8, S.UINT32, { optional: true }),
          cookieName: P(4, S.STRING, { optional: true }),
          cookieValue: P(5, S.STRING, { optional: true }),
          route: P(6, () => ({ type: P(1, S.UINT32, { optional: true }) }), { optional: true }),
        }),
        { optional: true },
      ),
    }),
    { optional: true },
  ),
};
function response(overrides: Record<string, unknown> = {}, status: number | undefined = 0) {
  return encodeEnvelope(
    new ProtoMsg(CollectorRespHead).encode(status === undefined ? {} : { retCode: status }),
    new ProtoMsg(rsp).encode({
      operation: {
        apply: {
          key: Uint8Array.from([0, 255, 128, 65]),
          httpsHost: 'download.weiyun.com',
          httpsPort: 443,
          cookieName: 'downloadkey',
          cookieValue: 'synthetic-download-ticket',
          route: { type: 1 },
          ...overrides,
        },
      },
    } as never),
  );
}
describe('collector original file/video download application', () => {
  it.each(['7.0.1-52892', '7.0.2-53644'])(
    'uses the observed header and 20014 descriptor for %s',
    async (build) => {
      const transport = vi.fn(async (request: CollectionHttpRequest) => {
        const bytes = Buffer.from(request.body),
          split = bytes.length - bytes.readUInt32BE(10);
        expect(decodeMessage(bytes.subarray(16, split), head)).toEqual({
          uin: 10001n,
          sequence: 1,
          command: 1,
          operation: 20014,
          version: 0x5f5e1642,
          client: 0x610,
          platform: 4,
          ticketType: 27,
          ticket: cred.pskey,
          f14: 8,
          f15: 9,
        });
        const body = decodeMessage(bytes.subarray(split), req).operation!.apply!;
        expect(body.cid).toBe('synthetic-cid');
        expect(body.thumbnail).toBe(false);
        expect(body.file).toEqual({
          ...file,
          md5: Buffer.from(file.md5),
          sha1: Buffer.alloc(0),
          category: 0,
          ntUid: '',
        });
        return response();
      });
      const resource = await applyCollectionFileDownload(cred, 'synthetic-cid', file, build, {
        transport,
      });
      expect(resource).toEqual({
        url: 'https://download.weiyun.com/ftn_handler/00ff8041/?fname=%E4%BE%8B%E5%AD%90.txt',
        cookie: 'downloadkey=synthetic-download-ticket',
      });
      expect(resource.cookie).not.toContain(cred.pskey);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses unknown builds or incomplete source identity without dispatch', async () => {
    const transport = vi.fn();
    for (const [build, metadata] of [
      ['7.0.3-unknown', file],
      ['7.0.2-53644', { ...file, md5: new Uint8Array(15) }],
      ['7.0.2-53644', { ...file, size: -1n }],
      ['7.0.2-53644', { ...file, fid: 'bad\n' }],
    ] as const)
      await expect(
        applyCollectionFileDownload(cred, 'synthetic-cid', metadata, build, { transport }),
      ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { httpsHost: 'qq.com.evil.invalid' },
    { httpsHost: '127.0.0.1' },
    { httpsHost: 'images.qpic.cn' },
    { httpsHost: 'user@qq.com' },
    { httpsPort: 9443 },
    { cookieName: 'bad=key' },
    { cookieValue: 'bad\r\nHeader: value' },
    { key: new Uint8Array() },
    { route: { type: 2 } },
  ])('rejects unsafe or unsupported download routes %j', async (overrides) => {
    await expect(
      applyCollectionFileDownload(cred, 'cid', file, '7.0.2-53644', {
        transport: async () => response(overrides),
      }),
    ).rejects.toThrow();
  });
  it('retains service rejection without reflecting private response text', async () => {
    await expect(
      applyCollectionFileDownload(cred, 'cid', file, '7.0.2-53644', {
        transport: async () => response({}, -10003),
      }),
    ).rejects.toThrow('代码 -10003');
  });
  it('does not accept an empty response operation', async () => {
    const bytes = encodeEnvelope(
      new ProtoMsg(CollectorRespHead).encode({ trace: 'synthetic' }),
      new ProtoMsg(rsp).encode({}),
    );
    await expect(
      applyCollectionFileDownload(cred, 'cid', file, '7.0.2-53644', {
        transport: async () => bytes,
      }),
    ).rejects.toThrow();
  });
  it('rejects cancellation before returning an ephemeral resource', async () => {
    const controller = new AbortController();
    await expect(
      applyCollectionFileDownload(cred, 'cid', file, '7.0.2-53644', {
        signal: controller.signal,
        transport: async () => {
          controller.abort(new Error('stop'));
          return response();
        },
      }),
    ).rejects.toThrow();
  });
});
