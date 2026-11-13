import type { IpcMainEvent, WebContents, WebFrameMain } from 'electron';

interface ReplyEvent {
  sender: Pick<WebContents, 'isDestroyed'>;
  senderFrame: Pick<WebFrameMain, 'isDestroyed' | 'detached'> | null;
  reply: IpcMainEvent['reply'];
}

function isDisposedFrameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Render frame was disposed before WebFrameMain could be accessed'
  );
}

/** electron-trpc 只检查 WebContents，页面刷新后旧帧可能已先行释放。 */
export function guardTrpcReply(event: ReplyEvent): void {
  const reply = event.reply.bind(event);
  // senderFrame 是延迟解析的 getter；必须在首次异步让出前保存，不能等回复时再读取。
  let frame: ReplyEvent['senderFrame'] = null;
  try {
    if (!event.sender.isDestroyed()) frame = event.senderFrame;
  } catch (error) {
    if (!isDisposedFrameError(error)) throw error;
  }
  event.reply = (channel, ...args) => {
    try {
      if (event.sender.isDestroyed()) return;
      if (!frame || frame.isDestroyed() || frame.detached) return;
      reply(channel, ...args);
    } catch (error) {
      // 检查与回复之间仍可能释放帧，只忽略这一种生命周期竞态。
      if (isDisposedFrameError(error)) return;
      throw error;
    }
  };
}
