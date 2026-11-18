import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { decodeElement, encodeElement, ProtoMsg, type Element } from '@weq/codec';
import { DraftBody } from '@weq/codec/proto/msg/43002_draft';
import { MAX_SHARED_DRAFT_IMAGE_BYTES } from '@weq/service/client-preferences';
import { composerDraftRecovery } from '../src/renderer/src/lib/composerDraftRecovery';
import {
  preserveComposerImages,
  preserveReeditImages,
  restoreComposerImages,
  composerAssetIds,
  removeUnusedComposerImages,
  shareComposerImages,
  type ComposerMediaStore,
} from '../src/renderer/src/lib/composerDraftMedia';
import {
  attachmentToken,
  type ComposerAttachment,
} from '../src/renderer/src/im-template/template/composerMedia';
import {
  elementToToken,
  elementPreviewSrc,
  tokenToElement,
} from '../src/renderer/src/im-template/template/draftElements';
import {
  buildComposerSendPlan,
  resolveComposerMedia,
} from '../src/renderer/src/im-template/template/composerSend';
import { localFileUrl } from '../src/renderer/src/lib/resourceUrl';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const files = new Map<string, File>();
  const store: ComposerMediaStore = {
    put: async (key, file) => {
      files.set(key, file);
    },
    get: async (key) => files.get(key),
    remove: async (key) => {
      files.delete(key);
    },
  };
  const image: ComposerAttachment = {
    id: 'fixture-image',
    kind: 'image',
    file: new File(['pixels'], 'image.png', { type: 'image/png' }),
    name: 'image.png',
    size: 6,
    mime: 'image/png',
    url: 'blob:old-process',
    width: 3,
    height: 2,
  };
  return { store, image, files };
}
it('共享图片先真实转存，去掉仅本机素材标识和 blob 地址，重复引用只传一次', async () => {
  const f = fixture();
  await preserveComposerImages('account', 'conversation', [f.image], f.store);
  const token = attachmentToken(f.image);
  const stage = vi.fn(async (file: File) => {
    expect(await file.text()).toBe('pixels');
    return '/synthetic/shared/image.png';
  });
  const shared = await shareComposerImages(
    'account',
    'conversation',
    `${token}${token}`,
    stage,
    f.store,
  );
  expect(stage).toHaveBeenCalledTimes(1);
  expect(composerAssetIds(shared).size).toBe(0);
  const element = tokenToElement(shared.match(/\[\[chat:elem:[^\]]+\]\]/)![0]);
  expect(element).toMatchObject({ kind: 'pic', localPath: '/synthetic/shared/image.png' });
  expect(element).not.toHaveProperty('localPreviewUrl');
  expect(element).not.toHaveProperty('localDraftAssetId');
  expect(f.files.size).toBe(1);
});
it('共享图片走真实 wire 往返后仍能预览，并通过宿主的资源代理读取原图发送', async () => {
  const f = fixture();
  const path = '/synthetic/shared/image.png';
  f.image.subType = 1;
  await preserveComposerImages('account', 'conversation', [f.image], f.store);
  const shared = await shareComposerImages(
    'account',
    'conversation',
    attachmentToken(f.image),
    async () => path,
    f.store,
  );
  const codec = new ProtoMsg(DraftBody);
  const encoded = codec.encode({
    entry: { elements: [encodeElement(tokenToElement(shared) as Element)] },
  });
  const restored = decodeElement(codec.decode(encoded).entry!.elements![0]!);
  expect(elementPreviewSrc(restored)).toBe(localFileUrl(path));
  const fetcher = vi.fn(async () => new Response('pixels'));
  vi.stubGlobal('fetch', fetcher);
  const body = elementToToken(restored);
  const locals = await resolveComposerMedia(body);
  expect(fetcher.mock.calls).toEqual([[localFileUrl(path)]]);
  expect(buildComposerSendPlan({ body, locals, superStickers: new Map() })).toEqual({
    kind: 'elements',
    elements: [
      {
        kind: 'image',
        fileName: 'image.png',
        width: 3,
        height: 2,
        subType: 1,
        source: new TextEncoder().encode('pixels'),
      },
    ],
  });
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(resolveComposerMedia(body)).rejects.toThrow('草稿图片');
});
it('超过共享上限的图片在分段上传前拒绝，保留原素材', async () => {
  const f = fixture();
  Object.defineProperty(f.image.file, 'size', { value: MAX_SHARED_DRAFT_IMAGE_BYTES + 1 });
  await preserveComposerImages('a', 'c', [f.image], f.store);
  const stage = vi.fn(async () => '/synthetic/shared/image.png');
  await expect(
    shareComposerImages('a', 'c', attachmentToken(f.image), stage, f.store),
  ).rejects.toThrow('共享草稿图片');
  expect(stage).not.toHaveBeenCalled();
  expect(f.files.size).toBe(1);
});
it('真实图片文件先保存，重建新地址后正文及素材可发送，账号和会话隔离', async () => {
  const f = fixture();
  f.image.subType = 1;
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new-process');
  await preserveComposerImages('account', 'conversation', [f.image], f.store);
  const token = attachmentToken(f.image);
  const source = `前文\n${token}后文`;
  const restored = await restoreComposerImages('account', 'conversation', source, f.store);
  const body = restored.rewrite(source);
  expect(body).toContain('前文\n');
  expect(body.endsWith('后文')).toBe(true);
  expect(composerAssetIds(body)).toEqual(new Set(['fixture-image']));
  const nextToken = body.match(/\[\[chat:elem:[^\]]+\]\]/)![0];
  expect(tokenToElement(nextToken)).toMatchObject({
    localPreviewUrl: 'blob:new-process',
    localDraftAssetId: 'fixture-image',
    subType: 1,
  });
  expect(await restored.images[0]!.file.text()).toBe('pixels');
  await expect(
    restoreComposerImages('other-account', 'conversation', source, f.store),
  ).rejects.toThrow('缺失');
  await expect(
    restoreComposerImages('account', 'other-conversation', source, f.store),
  ).rejects.toThrow('缺失');
});
it('持久事务失败不标记保存成功，已删除 token 不会被迟到恢复重新插回正文', async () => {
  const f = fixture();
  const broken = {
    ...f.store,
    put: async () => {
      throw new Error('disk full');
    },
  };
  await expect(preserveComposerImages('a', 'c', [f.image], broken)).rejects.toThrow();
  expect(f.image.draftAssetId).toBeUndefined();
  await preserveComposerImages('a', 'c', [f.image], f.store);
  const result = await restoreComposerImages('a', 'c', attachmentToken(f.image), f.store);
  expect(result.rewrite('用户后来输入的新正文')).toBe('用户后来输入的新正文');
});

it('编辑期间不删除撤销可能用到的素材，离开后只清理快照不再引用的图片', async () => {
  vi.stubGlobal('localStorage', new Storage());
  const f = fixture();
  const scope = JSON.stringify(['90001', 'live']);
  const otherScope = JSON.stringify(['90001', 'backup']);
  await preserveComposerImages(scope, 'c', [f.image], f.store);
  const body = attachmentToken(f.image);
  composerDraftRecovery.write(scope, 'c', body);
  await removeUnusedComposerImages(scope, 'c', ['fixture-image'], f.store);
  expect(f.files.size).toBe(1);
  expect((await restoreComposerImages(scope, 'c', body, f.store)).images[0]?.file).toBe(
    f.image.file,
  );
  await expect(restoreComposerImages(otherScope, 'c', body, f.store, '90001')).rejects.toThrow(
    '缺失',
  );
  composerDraftRecovery.write(scope, 'c', '');
  expect(f.files.size).toBe(1);
  await removeUnusedComposerImages(scope, 'c', ['fixture-image'], f.store);
  expect(f.files.size).toBe(0);
});

it.each(['blob:reedit-preview', '/_media/pic?reedit=1'])(
  '重新编辑的图片持久保存已读取的字节：%s',
  async (url) => {
    const f = fixture();
    const source = elementToToken({
      kind: 'pic',
      localPreviewUrl: url,
      fileName: 'reedit.png',
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const preserved = await preserveReeditImages(
      'a',
      'c',
      source,
      [
        {
          key: 'blob:original',
          previewUrl: url,
          bytes: new Uint8Array([1, 2, 3]),
          name: 'reedit.png',
        },
      ],
      new AbortController().signal,
      f.store,
    );
    expect(composerAssetIds(preserved.body).size).toBe(1);
    expect([...new Uint8Array(await preserved.images[0]!.file.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
