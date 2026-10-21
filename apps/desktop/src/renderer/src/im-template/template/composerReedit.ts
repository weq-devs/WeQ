import type { Message } from './types';
import type { LocalMediaRef } from './composerSend';
import { elementsToComposerText, composerTextToElements } from './draftElements';
import { repeatImageSources, type RepeatElement } from '../../lib/messageRepeat';

/** 从历史消息准备完整草稿；资源不可用时整次拒绝，不能只恢复文字。 */
export async function prepareReeditDraft(
  message: Message,
  elements: RepeatElement[],
  signal: AbortSignal,
): Promise<{ body: string; locals: LocalMediaRef[]; objectUrls: string[] }> {
  if (message.composerDraft) {
    const objectUrls: string[] = [];
    try {
      const savedElements = composerTextToElements(message.composerDraft.body);
      const referenced = new Set(
        savedElements.flatMap((element) => {
          if (!element || typeof element !== 'object') return [];
          const value = (element as Record<string, unknown>).localPreviewUrl;
          return typeof value === 'string' ? [value] : [];
        }),
      );
      const replacements = new Map<string, string>();
      const locals = (message.composerDraft.locals ?? []).map((local) => {
        if (!referenced.has(local.key) || !local.key.startsWith('blob:') || !local.bytes)
          return local;
        const url = URL.createObjectURL(new Blob([new Uint8Array(local.bytes).buffer]));
        objectUrls.push(url);
        replacements.set(local.key, url);
        return { ...local, key: url, previewUrl: url };
      });
      const body = replacements.size
        ? elementsToComposerText(
            savedElements.map((element) => {
              if (!element || typeof element !== 'object') return element;
              const raw = element as Record<string, unknown>;
              const url =
                typeof raw.localPreviewUrl === 'string'
                  ? replacements.get(raw.localPreviewUrl)
                  : undefined;
              return url ? { ...raw, localPreviewUrl: url } : raw;
            }),
          )
        : message.composerDraft.body;
      return { body, locals, objectUrls };
    } catch (error) {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      throw error;
    }
  }
  const locals: LocalMediaRef[] = [];
  const editable: Record<string, unknown>[] = [];
  let total = 0;
  for (const [index, element] of elements.entries()) {
    signal.throwIfAborted();
    const data = element.data ?? {};
    if (element.type !== 'pic') {
      editable.push({ ...data, kind: element.type });
      continue;
    }
    const time = Date.parse(message.createdAt);
    const resolvedUrls = new Map<RepeatElement, string>();
    const images = await repeatImageSources([element], time, signal, resolvedUrls);
    signal.throwIfAborted();
    const bytes = images.get(element)!;
    total += bytes.byteLength;
    if (total > 50 * 1024 * 1024) throw new Error('重新编辑的图片总计超过 50 MiB，请减少图片。');
    const name = typeof data.fileName === 'string' ? data.fileName : `image-${index}`;
    const previewUrl = resolvedUrls.get(element)!;
    // 独立 key 避免同名图片互相覆盖；预览仍走原有账号资源代理。
    const key = `${previewUrl}${previewUrl.includes('?') ? '&' : '?'}reedit=${index}`;
    locals.push({ key, bytes, name, previewUrl });
    editable.push({ ...data, kind: 'pic', localPreviewUrl: key });
  }
  return {
    body: editable.length ? elementsToComposerText(editable) : message.body,
    locals,
    objectUrls: [],
  };
}
