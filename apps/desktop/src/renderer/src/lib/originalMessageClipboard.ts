import type { Message } from '../im-template/template/types';
import { createMediaId } from '../im-template/template/composerMedia';
import { prepareReeditDraft } from '../im-template/template/composerReedit';
import {
  composerTextToElements,
  elementsToComposerText,
  elementToToken,
  tokenToElement,
} from '../im-template/template/draftElements';
import type { LocalMediaRef } from '../im-template/template/composerSend';
import { messageContentText, type MessageClipboard } from './messageClipboard';

type ClipboardMessage = Pick<Message, 'body' | 'createdAt' | 'qqElements' | 'composerDraft'>;
type ClipboardSource = { account: string; conversation: string };
type OriginalClipboard = ClipboardSource & { id: string; messages: ClipboardMessage[] };
const STORAGE_KEY = 'weq.message-clipboard';
const MAX_CLIPBOARD_SIZE = 2_000_000;
let latest: OriginalClipboard | null = null;

/** 系统剪贴板只带可读内容和随机标识；本机仅保留最后一份原始消息，供同源窗口恢复。 */
export function originalMessageClipboard(
  messages: readonly ClipboardMessage[],
  source: ClipboardSource,
  visible: MessageClipboard,
): MessageClipboard {
  const snapshot: OriginalClipboard = {
    ...source,
    id: createMediaId('message-clipboard'),
    messages: messages.map(({ body, createdAt, qqElements, composerDraft }) => ({
      body,
      createdAt,
      ...(qqElements ? { qqElements } : {}),
      ...(composerDraft ? { composerDraft } : {}),
    })),
  };
  const encoded = elementToToken(snapshot);
  if (encoded.length > MAX_CLIPBOARD_SIZE) throw new Error('消息剪贴记录过大，请减少选中的消息。');
  // 独立快照不能随原消息更新；File 等页面本体由内存记录保留，不写进剪贴板。
  latest = tokenToElement(encoded) as OriginalClipboard;
  latest.messages.forEach((message, index) => {
    const draft = snapshot.messages[index]?.composerDraft;
    if (draft)
      message.composerDraft = { ...draft, locals: draft.locals?.map((local) => ({ ...local })) };
  });
  try {
    localStorage.setItem(STORAGE_KEY, encoded);
  } catch {
    // 禁用存储时仍支持当前窗口内往返。
  }
  const root = document.createElement('div');
  root.dataset.weqMessageClipboard = snapshot.id;
  root.style.whiteSpace = 'pre-wrap';
  if (visible.html) root.innerHTML = visible.html;
  else root.textContent = visible.text;
  return { text: visible.text, html: root.outerHTML };
}

export function readOriginalMessageClipboard(
  html: string,
  account: string,
): OriginalClipboard | null {
  if (!html || html.length > MAX_CLIPBOARD_SIZE) return null;
  const id = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('[data-weq-message-clipboard]')
    ?.getAttribute('data-weq-message-clipboard');
  if (!id) return null;
  let snapshot = latest;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      if (stored.length > MAX_CLIPBOARD_SIZE) return null;
      const value = tokenToElement(stored) as OriginalClipboard | null;
      if (value?.id !== latest?.id) snapshot = value;
    }
  } catch {
    // 与写入端一致，在受限环境回落当前窗口记录。
  }
  return snapshot?.id === id && snapshot.account === account && Array.isArray(snapshot.messages)
    ? snapshot
    : null;
}

/** 顺序恢复草稿；图片取回后转为独立预览，沿用草稿图片保存和发送通路。 */
export async function prepareOriginalMessageClipboard(
  snapshot: OriginalClipboard,
  conversation: string,
  signal: AbortSignal,
): Promise<{ body: string; locals: LocalMediaRef[]; objectUrls: string[] }> {
  const bodies: string[] = [];
  const locals: LocalMediaRef[] = [];
  const objectUrls: string[] = [];
  let mediaBytes = 0;
  try {
    for (const message of snapshot.messages) {
      signal.throwIfAborted();
      const elements = (message.qqElements ?? []).flatMap((element) =>
        snapshot.conversation !== conversation && element.type === 'reply'
          ? [{ type: 'text', data: { textContent: `${messageContentText([element])}\n` } }]
          : [element],
      );
      const prepared = await prepareReeditDraft(
        {
          ...message,
          ...(snapshot.conversation !== conversation ? { composerDraft: undefined } : {}),
        },
        elements,
        signal,
      );
      objectUrls.push(...prepared.objectUrls);
      mediaBytes += prepared.locals.reduce(
        (size, local) => size + (local.bytes?.byteLength ?? 0),
        0,
      );
      if (mediaBytes > 50 * 1024 * 1024)
        throw new Error('粘贴消息的图片总计超过 50 MiB，请减少选中的消息。');
      const replacements = new Map<string, string>();
      for (const local of prepared.locals) {
        if (!local.bytes || local.key.startsWith('blob:')) continue;
        const url = URL.createObjectURL(new Blob([new Uint8Array(local.bytes)]));
        objectUrls.push(url);
        replacements.set(local.key, url);
      }
      locals.push(
        ...prepared.locals.map((local) => {
          const url = replacements.get(local.key);
          return url ? { ...local, key: url, previewUrl: url } : local;
        }),
      );
      bodies.push(
        elementsToComposerText(
          composerTextToElements(prepared.body).map((element) => {
            const raw = element as Record<string, unknown>;
            const url =
              typeof raw.localPreviewUrl === 'string'
                ? replacements.get(raw.localPreviewUrl)
                : undefined;
            const copied = ['face', 'mface', 'video', 'ptt', 'file', 'multiMsg'].includes(
              String(raw.kind),
            )
              ? { ...raw, weqCopiedElement: true }
              : raw;
            return url ? { ...copied, localPreviewUrl: url } : copied;
          }),
        ),
      );
    }
    return { body: bodies.join('\n'), locals, objectUrls };
  } catch (error) {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    throw error;
  }
}
