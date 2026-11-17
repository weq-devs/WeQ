import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { client } from '../trpc/client';
import { IS_WEB } from '../lib/target.shared';

type Pending = { id: string; state: string; hostReceived?: boolean };
type Setter<T> = Dispatch<SetStateAction<T[]>>;

function receiptToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 每次尝试使用独立 token，旧尝试／旧账号的迟到回执不能改变新发送的阶段。 */
export function useOutgoingReceipts<A extends Pending, B extends Pending, C extends Pending>(
  scope: string,
  messages: A[],
  arks: B[],
  forwards: C[],
  setMessages: Setter<A>,
  setArks: Setter<B>,
  setForwards: Setter<C>,
) {
  const channel = useRef('');
  const pending = useRef(new Map<string, string>());
  useEffect(() => {
    if (!IS_WEB) return;
    pending.current.clear();
    channel.current = receiptToken();
    let active = true;
    const subscription = client.account.outgoing.onReceived.subscribe(
      { channel: channel.current },
      {
        onData(token) {
          if (!active) return;
          const id = pending.current.get(token);
          if (!id) return;
          pending.current.delete(token);
          const received = <T extends Pending>(rows: T[]): T[] =>
            !rows.some((row) => row.id === id && row.state === 'sending')
              ? rows
              : rows.map((row) =>
                  row.id === id && row.state === 'sending' ? { ...row, hostReceived: true } : row,
                );
          setMessages(received);
          setArks(received);
          setForwards(received);
        },
      },
    );
    return () => {
      active = false;
      pending.current.clear();
      subscription.unsubscribe();
    };
  }, [scope, setMessages, setArks, setForwards]);

  useEffect(() => {
    const ids = new Set(
      [...messages, ...arks, ...forwards]
        .filter((row) => row.state === 'sending')
        .map((row) => row.id),
    );
    for (const [token, id] of pending.current) if (!ids.has(id)) pending.current.delete(token);
  }, [messages, arks, forwards]);

  return useCallback((id: string) => {
    if (!IS_WEB) return {};
    for (const [token, previous] of pending.current)
      if (previous === id) pending.current.delete(token);
    const token = receiptToken();
    pending.current.set(token, id);
    return { outgoingReceipt: { channel: channel.current, token } };
  }, []);
}
