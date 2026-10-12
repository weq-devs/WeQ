import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { CollectionCachedContent, CollectionItem } from '@weq/db';
import { CollectionService } from '../src/account/collection';
import type { WebNative } from '../src/account/web/credential';

vi.mock('../src/account/web/credential', () => ({
  WebCredentialProvider: class {
    async forDomain() {
      return { uin: '10001', skey: 'test', pskey: 'test' };
    }
  },
}));
vi.mock('../src/account/web/collection', () => ({
  getCollectionListNetwork: vi.fn(),
  getCollectionPageNetwork: vi.fn(),
}));

import { getCollectionListNetwork } from '../src/account/web/collection';

function item(): CollectionItem {
  return {
    cid: 'cid-1',
    type: 8,
    kind: 'richMedia',
    createTime: 0,
    collectTime: 10,
    modifyTime: 10,
    author: null,
    summary: { richMediaSummary: { brief: '摘要' } },
  };
}

describe('cloud summaries with local collection details', () => {
  it('keeps local full content when the network list replaces database rows', async () => {
    const cached: CollectionCachedContent = {
      recordTime: 10,
      richMedia: new Uint8Array([1]),
      richMediaContent: { rawData: '<div>完整内容</div>' },
    };
    const lookup = vi.fn(async () => new Map([['cid-1', cached]]));
    const session = {
      context: { uin: '10001' },
      collection: {
        cachedContentByCids: lookup,
      },
    } as unknown as AccountSession;
    vi.mocked(getCollectionListNetwork).mockResolvedValue({ items: [item()], hasMore: false });
    const service = new CollectionService({} as WebNative, session, () => 123);
    const page = await service.listCollectionsFromNetwork();
    expect(lookup).toHaveBeenCalledWith(['cid-1']);
    expect(page?.items[0]?.cachedContent?.richMediaContent?.rawData).toBe('<div>完整内容</div>');
  });

  it('re-reads the selected item without requesting a network list', async () => {
    const getByCid = vi.fn(async () => item());
    const session = {
      context: { uin: '10001' },
      collection: { getByCid },
    } as unknown as AccountSession;
    const service = new CollectionService({} as WebNative, session, () => 123);
    const calls = vi.mocked(getCollectionListNetwork).mock.calls.length;
    expect((await service.readCachedDetail('cid-1'))?.cid).toBe('cid-1');
    expect(getByCid).toHaveBeenCalledWith('cid-1');
    expect(vi.mocked(getCollectionListNetwork).mock.calls.length).toBe(calls);
  });
});
