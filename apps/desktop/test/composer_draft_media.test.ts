import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { composerDraftRecovery } from '../src/renderer/src/lib/composerDraftRecovery';
import {
  preserveComposerImages,
  preserveReeditImages,
  restoreComposerImages,
  composerAssetIds,
  removeUnusedComposerImages,
  type ComposerMediaStore,
} from '../src/renderer/src/lib/composerDraftMedia';
import {
  attachmentToken,
  type ComposerAttachment,
} from '../src/renderer/src/im-template/template/composerMedia';
import {
  elementToToken,
  tokenToElement,
} from '../src/renderer/src/im-template/template/draftElements';

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
it('真实图片文件先保存，重建新地址后正文及素材可发送，账号和会话隔离', async () => {
  const f = fixture();
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
  await preserveComposerImages('a', 'c', [f.image], f.store);
  composerDraftRecovery.write('a', 'c', attachmentToken(f.image));
  await removeUnusedComposerImages('a', 'c', ['fixture-image'], f.store);
  expect(f.files.size).toBe(1);
  composerDraftRecovery.write('a', 'c', '');
  expect(f.files.size).toBe(1);
  await removeUnusedComposerImages('a', 'c', ['fixture-image'], f.store);
  expect(f.files.size).toBe(0);
});

it('重新编辑的图片从已有媒体字节保存，不依赖旧进程的 Blob 地址', async () => {
  const f = fixture();
  const source = elementToToken({
    kind: 'pic',
    localPreviewUrl: 'blob:reedit-preview',
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
        previewUrl: 'blob:reedit-preview',
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
});
