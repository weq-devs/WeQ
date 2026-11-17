import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useOutgoingReceipts } from '../src/renderer/src/hooks/useOutgoingReceipts';

const rpc = vi.hoisted(() => ({
  receive: undefined as ((token: string) => void) | undefined,
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/lib/target.shared', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      outgoing: {
        onReceived: {
          subscribe: (_: unknown, handler: { onData: (token: string) => void }) => {
            rpc.receive = handler.onData;
            return { unsubscribe: rpc.unsubscribe };
          },
        },
      },
    },
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  rpc.unsubscribe.mockClear();
});

it('只有本次请求真实到达电脑才改变阶段；失败、重试及切号后的迟到回执不回灌', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  let receipt!: ReturnType<typeof useOutgoingReceipts>;
  let set!: (state: 'sending' | 'failed') => void;
  const observed: Array<{ hostReceived?: boolean }> = [];
  function Fixture({ scope }: { scope: string }) {
    const [rows, setRows] = useState([{ id: 'm', state: 'sending', hostReceived: false }]);
    const [arks, setArks] = useState<typeof rows>([]);
    const [forwards, setForwards] = useState<typeof rows>([]);
    receipt = useOutgoingReceipts(scope, rows, arks, forwards, setRows, setArks, setForwards);
    set = (state) => setRows([{ id: 'm', state, hostReceived: false }]);
    observed.push(rows[0]!);
    return h('output', null, JSON.stringify(rows[0]));
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Fixture, { scope: 'a' })));
    const first = receipt('m').outgoingReceipt!;
    expect(observed.at(-1)?.hostReceived).toBe(false);
    await act(async () => rpc.receive!('unrelated'));
    expect(observed.at(-1)?.hostReceived).toBe(false);
    await act(async () => rpc.receive!(first.token));
    expect(observed.at(-1)?.hostReceived).toBe(true);
    await act(async () => set('sending'));
    const old = receipt('m').outgoingReceipt!;
    const retry = receipt('m').outgoingReceipt!;
    await act(async () => rpc.receive!(old.token));
    expect(observed.at(-1)?.hostReceived).toBe(false);
    await act(async () => set('failed'));
    await act(async () => rpc.receive!(retry.token));
    expect(observed.at(-1)?.hostReceived).toBe(false);
    await act(async () => set('sending'));
    const stale = receipt('m').outgoingReceipt!;
    const previousHandler = rpc.receive!;
    await act(async () => root.render(h(Fixture, { scope: 'b' })));
    await act(async () => previousHandler(stale.token));
    expect(observed.at(-1)?.hostReceived).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
  expect(rpc.unsubscribe).toHaveBeenCalledTimes(2);
});
