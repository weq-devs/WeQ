import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { CollectorRespHead, CollectorRespBody } from '@weq/codec/proto/collection/index';
import { getCollectionPageNetwork, encodeEnvelope } from '../src/account/web/collection';
import { collectionMediaReferences } from '../src/account/collection_media';
const cred = { uin: '10001', skey: '', pskey: 'synthetic-ticket' };
function fixture(values: {
  duration?: number;
  format?: number;
  category?: number;
  previewType?: number;
  storeType?: number;
}) {
  const bytes = Buffer.from('synthetic-video-original');
  const response = new ProtoMsg(CollectorRespBody).encode({
    operation: {
      getCollectionList: {
        items: [
          {
            cid: 'synthetic-video-cid',
            type: 5,
            modifyTime: 9n,
            summary: {
              videoSummary: {
                field1: 'synthetic video',
                field2: values.duration,
                field3: values.format,
                field10: values.category,
                field20: values.previewType,
                field30: values.storeType,
                picture: { url: 'https://qpic.cn/synthetic-cover', size: 3 },
                file: {
                  src: 2,
                  bid: 236,
                  fid: 'synthetic-video-fid',
                  name: 'sample.mp4',
                  size: 9007199254741123n,
                  md5: createHash('md5').update(bytes).digest(),
                },
              },
            },
          },
        ],
        reachedBottom: 1,
        totalCount: 1,
      },
    },
  });
  return encodeEnvelope(new ProtoMsg(CollectorRespHead).encode({ retCode: 0 }), response);
}
describe('official collector video summary mapping', () => {
  it('preserves video metadata and the exact original descriptor across a network page', async () => {
    const data = { duration: 17, format: 2, category: 4, previewType: 1, storeType: 3 };
    const page = await getCollectionPageNetwork(cred, null, {
      transport: async () => fixture(data),
    });
    const item = page.items[0]!;
    expect(item.summary.videoSummary).toMatchObject({
      ...data,
      title: 'synthetic video',
      storeFileInfo: { fid: 'synthetic-video-fid', name: 'sample.mp4', size: 9007199254741123n },
    });
    const refs = collectionMediaReferences(item.cid, null, item);
    expect(refs.map((ref) => [ref.kind, ref.sourceRole])).toEqual([
      ['image', 'preview'],
      ['video', 'original-candidate'],
    ]);
    expect(refs[1]).toMatchObject({
      expectedSize: '9007199254741123',
      storedFile: { fid: 'synthetic-video-fid', src: 2, bid: 236 },
    });
  });
  it('retains explicit zero values while leaving absent metadata unknown', async () => {
    const zero = await getCollectionPageNetwork(cred, null, {
      transport: async () =>
        fixture({ duration: 0, format: 0, category: 0, previewType: 0, storeType: 0 }),
    });
    expect(zero.items[0]!.summary.videoSummary).toMatchObject({
      duration: 0,
      format: 0,
      category: 0,
      previewType: 0,
      storeType: 0,
    });
    const absent = await getCollectionPageNetwork(cred, null, {
      transport: async () => fixture({}),
    });
    expect(absent.items[0]!.summary.videoSummary?.duration).toBeUndefined();
    expect(absent.items[0]!.summary.videoSummary?.storeType).toBeUndefined();
  });
});
