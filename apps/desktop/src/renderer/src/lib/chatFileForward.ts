import {
  chatFileForwardInput,
  type ChatFileForwardSource,
} from '../../../shared/chat_file_forward';
import type { Message } from '../im-template/template/types';
import { useDialog } from '../components/Dialog.shared';
import type { RepeatElement } from './messageRepeat';
import { formatFileSize } from '../im-template/template/composerMedia';

const isMessageId = (id?: string): id is string => /^\d{1,20}$/.test(id ?? '');

export function chatFileForwardSource(
  message: Message,
  element: RepeatElement,
): ChatFileForwardSource | undefined {
  if (element.type !== 'file') return;
  if (element.data?.chatFile) return chatFileForwardInput.safeParse(element.data.chatFile).data;
  const { fileName, fileToken } = element.data ?? {};
  if (typeof fileName !== 'string' || !fileName) return;
  const token = typeof fileToken === 'string' ? fileToken : '';
  const snapshot = message.forwardSnapshot;
  if (snapshot) {
    if (!isMessageId(snapshot.carrierId) && !(snapshot.resId && token)) return;
    return {
      kind: 'chat-file',
      msgId: isMessageId(snapshot.carrierId) ? snapshot.carrierId : '0',
      name: fileName,
      token,
      conv: snapshot.conv,
      fwdKind: snapshot.kind,
      fwdResId: snapshot.resId,
      ...(isMessageId(message.msgId) ? { fwdMsgId: message.msgId } : {}),
    };
  }
  return isMessageId(message.msgId) && message.conversationId
    ? {
        kind: 'chat-file',
        msgId: message.msgId,
        name: fileName,
        token,
        conv: message.conversationId,
      }
    : undefined;
}

export function singleChatFile(message: Message): ChatFileForwardSource | undefined {
  const elements = (message.qqElements ?? []).filter(
    ({ type, data }) => type !== 'reply' && !(type === 'text' && !data?.textContent),
  );
  if (elements.length === 1 && elements[0]) return chatFileForwardSource(message, elements[0]);
}

type Pending = { key: string; name: string; size: number };
let confirmationQueue = Promise.resolve();

/** 多个目标并行时，依次询问，避免全局确认框互相替换。 */
export async function forwardWithFileConfirmation<T extends { status: 'sent' }>(
  send: (confirmed: string[]) => Promise<T | { status: 'confirm'; files: Pending[] }>,
  targetName: string,
  isCurrent: () => boolean,
): Promise<T | null> {
  const confirmed: string[] = [];
  while (isCurrent()) {
    const result = await send(confirmed);
    if (result.status === 'sent') return result;
    const files = result.files.filter(({ key }) => !confirmed.includes(key));
    if (!files.length) throw new Error('未能确认需重传的文件');
    const ask = confirmationQueue.then(() => {
      if (!isCurrent()) return false;
      const size = files.reduce((total, file) => total + file.size, 0);
      const subject = files.length === 1 ? `「${files[0]?.name}」` : `${files.length} 个文件`;
      return useDialog
        .getState()
        .confirm(
          '下载并重传文件？',
          `${subject}无法直接转发给「${targetName}」。继续后，WeQ 会从 QQ 下载 ${formatFileSize(size)}，再发送到该会话。`,
          { okLabel: '下载并发送', cancelLabel: '取消转发' },
        );
    });
    confirmationQueue = ask.then(
      () => undefined,
      () => undefined,
    );
    if (!(await ask)) return null;
    confirmed.push(...files.map(({ key }) => key));
  }
  return null;
}
