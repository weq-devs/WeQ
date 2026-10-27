import type { ComposerAttachment } from '../im-template/template/composerMedia';
import { createMediaId } from '../im-template/template/composerMedia';
import type { LocalMediaRef } from '../im-template/template/composerSend';
import { elementToToken, tokenToElement } from '../im-template/template/draftElements';
import { releaseObjectUrl } from './objectUrl';
import { composerDraftRecovery } from './composerDraftRecovery';

export interface ComposerMediaStore {
  put(key: string, file: File): Promise<void>;
  get(key: string): Promise<File | undefined>;
  remove(key: string): Promise<void>;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('weq-composer-draft-media', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('草稿图片存储不可用'));
      request.onblocked = () => reject(new Error('草稿图片存储被占用'));
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}
const mediaStore: ComposerMediaStore = {
  async put(key, file) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite', { durability: 'strict' });
      tx.objectStore('files').put(file, key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('草稿图片保存失败'));
    });
  },
  async get(key) {
    const db = await openDatabase();
    return new Promise<File | undefined>((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get(key);
      request.onsuccess = () => resolve(request.result as File | undefined);
      request.onerror = () => reject(new Error('草稿图片读取失败'));
    });
  },
  async remove(key) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('草稿图片清理失败'));
    });
  },
};
const assetKey = (account: string, conversation: string, id: string) =>
  JSON.stringify([account, conversation, id]);
const tokens = (body: string) => body.match(/\[\[chat:elem:[^\]]+\]\]/g) ?? [];
function asset(token: string): Record<string, unknown> | null {
  const value: unknown = tokenToElement(token);
  return value &&
    typeof value === 'object' &&
    'localDraftAssetId' in value &&
    typeof value.localDraftAssetId === 'string'
    ? (value as Record<string, unknown>)
    : null;
}

export function composerAssetIds(body: string): Set<string> {
  return new Set(
    tokens(body).flatMap((token) => {
      const value = asset(token);
      return value ? [value.localDraftAssetId as string] : [];
    }),
  );
}

/** 先提交 File 的持久事务，再把带稳定素材标识的图片放进输入框。 */
export async function preserveComposerImages(
  account: string,
  conversation: string,
  images: ComposerAttachment[],
  store = mediaStore,
): Promise<void> {
  for (const image of images) {
    const id = image.draftAssetId ?? image.id;
    await store.put(assetKey(account, conversation, id), image.file);
    image.draftAssetId = id;
  }
}

/** 重新编辑的本地 Blob 也需落盘；只读取当前页面拥有的 blob URL，不请求远程地址。 */
export async function preserveReeditImages(
  account: string,
  conversation: string,
  body: string,
  locals: readonly LocalMediaRef[],
  signal: AbortSignal,
  store = mediaStore,
) {
  const images: ComposerAttachment[] = [];
  const replacements = new Map<string, string>();
  try {
    for (const token of tokens(body)) {
      const value: unknown = tokenToElement(token);
      if (
        !value ||
        typeof value !== 'object' ||
        !('kind' in value) ||
        value.kind !== 'pic' ||
        !('localPreviewUrl' in value) ||
        typeof value.localPreviewUrl !== 'string' ||
        !value.localPreviewUrl.startsWith('blob:')
      )
        continue;
      if (signal.aborted) throw new DOMException('已取消草稿恢复', 'AbortError');
      const data = value as Record<string, unknown>;
      const local = locals.find(
        (item) => item.key === value.localPreviewUrl || item.previewUrl === value.localPreviewUrl,
      );
      const blob = local?.bytes
        ? new Blob([new Uint8Array(local.bytes)])
        : await fetch(value.localPreviewUrl, { signal }).then((response) => {
            if (!response.ok) throw new Error('草稿图片读取失败');
            return response.blob();
          });
      const file = new File([blob], String(data.fileName || local?.name || 'draft.png'), {
        type: blob.type || String(data.mimeType || 'image/png'),
      });
      const image: ComposerAttachment = {
        id: createMediaId('draft'),
        kind: 'image',
        file,
        name: file.name,
        size: file.size,
        mime: file.type,
        url: value.localPreviewUrl,
        width: Number(data.width) || 0,
        height: Number(data.height) || 0,
      };
      await preserveComposerImages(account, conversation, [image], store);
      images.push(image);
      if (signal.aborted) throw new DOMException('已取消草稿恢复', 'AbortError');
      replacements.set(token, elementToToken({ ...data, localDraftAssetId: image.draftAssetId }));
    }
    return {
      body: body.replace(/\[\[chat:elem:[^\]]+\]\]/g, (token) => replacements.get(token) ?? token),
      images,
    };
  } catch (error) {
    await removeComposerImages(
      account,
      conversation,
      images.flatMap((image) => (image.draftAssetId ? [image.draftAssetId] : [])),
      store,
    ).catch(() => {});
    throw error;
  }
}

export async function removeComposerImages(
  account: string,
  conversation: string,
  ids: Iterable<string>,
  store = mediaStore,
): Promise<void> {
  for (const id of ids) await store.remove(assetKey(account, conversation, id));
}

/** 离开编辑器或发送后清理；输入期间保留素材，允许撤销删除的图片。 */
export async function removeUnusedComposerImages(
  account: string,
  conversation: string,
  ids: Iterable<string>,
  store = mediaStore,
): Promise<void> {
  const retained = composerAssetIds(composerDraftRecovery.load(account)[conversation] ?? '');
  await removeComposerImages(
    account,
    conversation,
    [...ids].filter((id) => !retained.has(id)),
    store,
  );
}

/** 从真实素材重建本次进程的 URL；文本和 @/表情 token 不变，不自动发送。 */
export async function restoreComposerImages(
  account: string,
  conversation: string,
  body: string,
  store = mediaStore,
) {
  const images: ComposerAttachment[] = [];
  const replacements = new Map<string, string>();
  try {
    for (const token of tokens(body)) {
      const value = asset(token);
      if (!value) continue;
      const id = value.localDraftAssetId as string;
      let image = images.find((item) => item.id === id);
      if (!image) {
        const file = await store.get(assetKey(account, conversation, id));
        if (!file) throw new Error('草稿图片素材缺失，原稿仍已保留');
        image = {
          id,
          draftAssetId: id,
          file,
          kind: 'image',
          name: file.name,
          size: file.size,
          mime: file.type,
          url: URL.createObjectURL(file),
          width: Number(value.width) || 0,
          height: Number(value.height) || 0,
        };
        images.push(image);
      }
      replacements.set(token, elementToToken({ ...value, localPreviewUrl: image.url }));
    }
    return {
      images,
      rewrite: (current: string) =>
        current.replace(/\[\[chat:elem:[^\]]+\]\]/g, (token) => replacements.get(token) ?? token),
    };
  } catch (error) {
    for (const image of images) if (image.url) releaseObjectUrl(image.url);
    throw error;
  }
}
