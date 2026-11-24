import { z } from 'zod/v3';
import { observable } from '@trpc/server/observable';
import { procedure, router } from './trpc';

const receiptInput = z.object({ channel: z.string().uuid(), token: z.string().uuid() });
type Receipt = z.infer<typeof receiptInput>;
const KEEP_MS = 5 * 60_000;
const LIMIT = 512;

/** 仅保存随机回执，不保存正文；有界重放覆盖订阅迟到和短暂断线。 */
export class OutgoingReceipts {
  private received = new Map<string, Receipt & { at: number }>();
  private listeners = new Set<{ channel: string; notify: (token: string) => void }>();

  private prune() {
    const cutoff = Date.now() - KEEP_MS;
    for (const [key, receipt] of this.received) {
      if (receipt.at > cutoff) break;
      this.received.delete(key);
    }
  }

  accept(receipt: Receipt) {
    this.prune();
    const key = `${receipt.channel}:${receipt.token}`;
    if (this.received.has(key)) return;
    while (this.received.size >= LIMIT) this.received.delete(this.received.keys().next().value!);
    this.received.set(key, { ...receipt, at: Date.now() });
    for (const listener of this.listeners)
      if (listener.channel === receipt.channel) listener.notify(receipt.token);
  }

  subscribe(channel: string, notify: (token: string) => void): () => void {
    this.prune();
    const listener = { channel, notify };
    this.listeners.add(listener);
    for (const receipt of this.received.values())
      if (receipt.channel === channel) notify(receipt.token);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const receipts = new OutgoingReceipts();

// 回执只表示完整发送请求已到宿主，不代表 QQ 已接收或消息已发送成功。
export const outgoingProcedure = procedure
  .input(z.object({ outgoingReceipt: receiptInput.optional() }))
  .use(({ input, next }) => {
    if (input.outgoingReceipt) receipts.accept(input.outgoingReceipt);
    return next();
  });

export const outgoingRouter = router({
  onReceived: procedure
    .input(z.object({ channel: z.string().uuid() }))
    .subscription(({ input }) =>
      observable<string>((emit) => receipts.subscribe(input.channel, (token) => emit.next(token))),
    ),
});
