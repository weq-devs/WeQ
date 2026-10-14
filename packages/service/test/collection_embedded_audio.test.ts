import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { CollectionCachedContent } from '@weq/db';
import type { WebNative } from '../src/account/web/credential';
import { CollectionService } from '../src/account/collection';
import {
  CollectionMediaStore,
  collectionEmbeddedAudio,
  collectionMediaReferences,
} from '../src/account/collection_media';

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'weq-embedded-audio-'));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function silk(frame = Buffer.from([7, 8, 9]), end = false): Buffer {
  const size = Buffer.alloc(2);
  size.writeInt16LE(frame.length);
  return Buffer.concat([
    Buffer.from('\x02#!SILK_V3'),
    size,
    frame,
    ...(end ? [Buffer.from([255, 255])] : []),
  ]);
}
const content = (bytes = silk()): CollectionCachedContent => ({
  fetched: true,
  recordTime: 0,
  audio: bytes,
});

describe('detail-embedded collection audio', () => {
  it('accepts framed SILK with or without the QQ prefix and optional terminal marker', () => {
    for (const bytes of [silk(), silk().subarray(1), silk(undefined, true)])
      expect(collectionEmbeddedAudio(content(bytes))).toEqual(bytes);
  });
  it('rejects incomplete frames, trailing bytes, zero frames and database protobuf envelopes', () => {
    for (const bytes of [
      silk().subarray(0, -1),
      Buffer.concat([silk(undefined, true), Buffer.from([0])]),
      Buffer.from('\x02#!SILK_V3'),
      Buffer.concat([Buffer.from([18, 20]), silk()]),
    ])
      expect(collectionEmbeddedAudio(content(bytes))).toBeNull();
  });
  it('keeps unknown binary audio visible as unresolved coverage', () => {
    expect(collectionMediaReferences('cid', content(Buffer.from([1, 2, 3])))).toMatchObject([
      { kind: 'audio', pointer: 'detail/audio/unresolved', uri: null, sourceRole: 'unknown' },
    ]);
  });
  it('saves exact bytes without fetching and keeps independent original verification unset', async () => {
    const path = root(),
      bytes = silk();
    const store = new CollectionMediaStore(path);
    const ref = collectionMediaReferences('cid', content(bytes))[0]!;
    const fetch = vi.fn();
    const receipt = await store.download(ref, { embeddedBytes: bytes, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      state: 'downloaded',
      role: 'unverified',
      bytes: bytes.length,
      md5: createHash('md5').update(bytes).digest('hex'),
      md5Matches: null,
      sizeMatches: null,
    });
    expect(readFileSync(join(path, receipt.file!))).toEqual(bytes);
    expect((await store.savedFile(ref.id)).name).toBe('语音.silk');
    const again = await new CollectionMediaStore(path).download(ref, { fetch });
    expect(again.sha256).toBe(receipt.sha256);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not reuse another embedded audio item or accept substituted source bytes', async () => {
    const path = root(),
      store = new CollectionMediaStore(path),
      bytes = silk(),
      other = silk(Buffer.from([4, 5, 6]));
    const first = collectionMediaReferences('cid', content(bytes))[0]!;
    const second = collectionMediaReferences('cid', content(other))[0]!;
    expect(first.id).not.toBe(second.id);
    const saved = await store.download(first, { embeddedBytes: bytes });
    const bad = await store.download(second, { embeddedBytes: bytes });
    expect(bad).toMatchObject({ state: 'failed', file: null });
    const good = await store.download(second, { embeddedBytes: other });
    expect(good.sha256).not.toBe(saved.sha256);
    expect(readFileSync(join(path, good.file!))).toEqual(other);
  });
  it('exports fresh cached detail audio without a manual download or online account', async () => {
    const path = root(),
      bytes = silk();
    const native = {
      sendOidbPacket: vi.fn(),
      probePtLoginPort: vi.fn(),
      ptFetchSkey: vi.fn(),
      ptFetchPskey: vi.fn(),
    };
    const session = {
      context: { uin: '10001' },
      collection: {
        cachedContentByCids: async () => new Map([['cid', content(bytes)]]),
        getByCid: async () => null,
      },
    } as unknown as AccountSession;
    const service = new CollectionService(
      native as WebNative,
      session,
      () => {
        throw Error('offline');
      },
      path,
    );
    const output = join(path, 'export');
    const entries = await service.exportCachedMedia('cid', output);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.receipt).toMatchObject({ state: 'downloaded', role: 'unverified' });
    expect(readFileSync(join(output, entries[0]!.file!))).toEqual(bytes);
    expect(native.sendOidbPacket).not.toHaveBeenCalled();
    expect(native.probePtLoginPort).not.toHaveBeenCalled();
  });
  it('honors cancellation before creating a media cache', async () => {
    const path = join(root(), 'cache'),
      controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const bytes = silk(),
      ref = collectionMediaReferences('cid', content(bytes))[0]!;
    await expect(
      new CollectionMediaStore(path).download(ref, {
        embeddedBytes: bytes,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(existsSync(path)).toBe(false);
  });
});
