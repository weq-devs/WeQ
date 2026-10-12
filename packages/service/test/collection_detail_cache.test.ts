import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  getCollectionDetailsNetwork: vi.fn(),
  getCollectionListNetwork: vi.fn(),
  getCollectionPageNetwork: vi.fn(),
}));

import {
  getCollectionDetailsNetwork,
  getCollectionListNetwork,
} from '../src/account/web/collection';

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

  it('fetches only missing details, saves the raw response, and reuses it after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-collection-service-detail-'));
    try {
      const official: CollectionCachedContent = {
        fetched: true,
        recordTime: 1,
        textContent: { data: 'QQ 已缓存' },
      };
      const cachedContentByCids = vi.fn(async (cids: readonly string[]) => {
        const values = new Map<string, CollectionCachedContent>();
        if (cids.includes('cid-official')) values.set('cid-official', official);
        return values;
      });
      const session = {
        context: { uin: '10001' },
        collection: { cachedContentByCids, getByCid: vi.fn(async () => null) },
      } as unknown as AccountSession;
      vi.mocked(getCollectionDetailsNetwork).mockImplementation(async (_cred, cids, options) => {
        await options?.onRawResponse?.({ cids, response: Uint8Array.of(4, 5, 6) });
        return cids.map((cid) => ({
          cid,
          content: { recordTime: 2, textContent: { data: `网络 ${cid}` } },
        }));
      });

      const first = new CollectionService({} as WebNative, session, () => 123, root);
      const details = await first.fetchDetails(['cid-official', 'cid-network']);
      expect(details.map((detail) => detail.content.textContent?.data)).toEqual([
        'QQ 已缓存',
        '网络 cid-network',
      ]);
      expect(vi.mocked(getCollectionDetailsNetwork).mock.calls[0]?.[1]).toEqual(['cid-network']);
      expect(
        readdirSync(join(root, 'details/accounts/10001/detail-raw')).filter((name) =>
          name.endsWith('.bin'),
        ),
      ).toHaveLength(1);

      vi.mocked(getCollectionDetailsNetwork).mockClear();
      const reopened = new CollectionService({} as WebNative, session, () => 123, root);
      expect(await reopened.readCachedDetail('cid-network')).toBeNull();
      expect((await reopened.readCachedContent('cid-network'))?.textContent?.data).toBe(
        '网络 cid-network',
      );
      expect((await reopened.fetchDetails(['cid-network']))[0]?.content.textContent?.data).toBe(
        '网络 cid-network',
      );
      expect(getCollectionDetailsNetwork).not.toHaveBeenCalled();
      cachedContentByCids.mockRejectedValueOnce(new Error('local db closed'));
      expect((await reopened.fetchDetails(['cid-network']))[0]?.content.textContent?.data).toBe(
        '网络 cid-network',
      );
      expect(getCollectionDetailsNetwork).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
