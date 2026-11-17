import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../src/main/ipc/trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.create();
  return { procedure: t.procedure, router: t.router };
});
import {
  OutgoingReceipts,
  outgoingProcedure,
  outgoingRouter,
} from '../src/main/ipc/outgoing_receipts';

afterEach(() => vi.useRealTimers());

it('电脑在发送结果返回前确认收到请求，不要求先收到订阅或 QQ 回执', async () => {
  const { router } = await import('../src/main/ipc/trpc');
  const channel = crypto.randomUUID();
  const token = crypto.randomUUID();
  let finish!: () => void;
  const caller = router({
    status: outgoingRouter,
    send: outgoingProcedure.input(z.object({ text: z.string() })).mutation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  }).createCaller({});
  const sent = caller.send({ text: '合成消息', outgoingReceipt: { channel, token } });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const received = vi.fn();
  const subscription = (await caller.status.onReceived({ channel })).subscribe({ next: received });
  expect(received).toHaveBeenCalledWith(token);
  finish();
  await sent;
  subscription.unsubscribe();
});

it('回执按随机通道隔离、去重，订阅移除后不再收到回执', () => {
  const store = new OutgoingReceipts();
  const channel = crypto.randomUUID();
  const token = crypto.randomUUID();
  const received = vi.fn();
  const other = vi.fn();
  const stop = store.subscribe(channel, received);
  store.subscribe(crypto.randomUUID(), other);
  store.accept({ channel, token });
  store.accept({ channel, token });
  expect(received).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  stop();
  store.accept({ channel, token: crypto.randomUUID() });
  expect(received).toHaveBeenCalledTimes(1);
});

it('回执重放有数量和时效上限', () => {
  vi.useFakeTimers();
  const store = new OutgoingReceipts();
  const channel = crypto.randomUUID();
  for (let i = 0; i < 600; i++) store.accept({ channel, token: crypto.randomUUID() });
  const received = vi.fn();
  store.subscribe(channel, received)();
  expect(received).toHaveBeenCalledTimes(512);
  vi.advanceTimersByTime(5 * 60_000);
  const expired = vi.fn();
  store.subscribe(channel, expired)();
  expect(expired).not.toHaveBeenCalled();
});
