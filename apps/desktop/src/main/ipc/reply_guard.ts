import type { IpcMainEvent, WebContents, WebFrameMain } from 'electron';

interface ReplyEvent {
  sender: Pick<WebContents, 'isDestroyed'>;
  senderFrame: Pick<WebFrameMain, 'isDestroyed' | 'detached'> | null;
  reply: IpcMainEvent['reply'];
}

/** electron-trpc 只检查 WebContents，页面刷新后旧帧可能已先行释放。 */
export function guardTrpcReply(event: ReplyEvent): void {
  const reply = event.reply.bind(event);
  event.reply = (channel, ...args) => {
    try {
      if (event.sender.isDestroyed()) return;
      const frame = event.senderFrame;
      if (!frame || frame.isDestroyed() || frame.detached) return;
      reply(channel, ...args);
    } catch (error) {
      // 检查与回复之间仍可能释放帧，只忽略这一种生命周期竞态。
      if (
        error instanceof Error &&
        error.message === 'Render frame was disposed before WebFrameMain could be accessed'
      ) {
        return;
      }
      throw error;
    }
  };
}
