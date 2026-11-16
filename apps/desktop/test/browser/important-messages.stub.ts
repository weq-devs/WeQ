import { useQuery } from '@tanstack/react-query';
import { IMPORTANT_MESSAGE_KINDS } from '../../src/renderer/src/im-template/template/unreadDock';

const calls: Record<string, unknown>[] = [];
Object.assign(window, { importantCalls: calls });
const mode = () => (window as unknown as { importantMode?: string }).importantMode ?? 'ready';
async function config() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { uin: '10001', configId: 'fixture' };
}
const kinds = IMPORTANT_MESSAGE_KINDS;
async function query(input: Record<string, unknown>) {
  calls.push(input);
  await new Promise((resolve) => setTimeout(resolve, 60));
  if (mode() === 'error') throw new Error('暂时无法读取重要消息');
  if (mode() === 'empty') return { items: [], nextBefore: null, contentUnavailable: false };
  const rows = Array.from({ length: 30 }, (_, index) => ({
    chatType: 2,
    uid: '777',
    msgSeq: String(1024 - index),
    msgId: String(9000 + index),
    senderUid: index % 2 ? 'u_long' : 'u_peer',
    sendTime: String(1794801600 - index * 480),
    unread: index < 3,
    preview:
      index === 1
        ? '很长的消息正文用于核对连续文本与换行。'.repeat(12)
        : index === 4
          ? '[图片]'
          : `周六活动 ${index + 1}：请在晚上八点前确认安排。`,
    thumbnail: index === 4 ? { name: 'fixture.png', token: 'fixture' } : undefined,
    reasons: [
      {
        kind: kinds[index % kinds.length],
        rawKind: 1000 + index,
        text: index === 4 ? '活动报名' : '',
      },
      ...(index === 0 ? [{ kind: 'replyMe', rawKind: 1002, text: '' }] : []),
    ],
  })).filter(
    (row) =>
      (!input.kind || row.reasons.some((reason) => reason.kind === input.kind)) &&
      (!Array.isArray(input.kinds) ||
        row.reasons.some((reason) => (input.kinds as string[]).includes(reason.kind))) &&
      (!input.unreadOnly || row.unread) &&
      (!input.before || BigInt(row.msgSeq) < BigInt(String(input.before))),
  );
  return {
    items: rows.slice(0, 20),
    nextBefore: rows.length > 20 ? rows[19]!.msgSeq : null,
    contentUnavailable: false,
  };
}
const fallback = (): unknown =>
  new Proxy(() => fallback(), {
    get: (_target, key) => {
      if (key === 'useQuery') return () => ({ data: undefined, isLoading: false });
      if (key === 'useMutation')
        return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isLoading: false });
      if (key === 'query') return async () => [];
      return fallback();
    },
  });
export const client = new Proxy(fallback() as object, {
  get: (_target, key) =>
    key === 'account'
      ? new Proxy(fallback() as object, {
          get: (_target, key) => (key === 'listImportantGroupMessages' ? { query } : fallback()),
        })
      : fallback(),
});
export const trpc = new Proxy(fallback() as object, {
  get: (_target, key) =>
    key === 'account'
      ? new Proxy(fallback() as object, {
          get: (_target, key) =>
            key === 'getAccountConfig'
              ? {
                  useQuery: (_: unknown, options: { enabled: boolean }) =>
                    useQuery({ queryKey: ['important-config'], queryFn: config, ...options }),
                }
              : fallback(),
        })
      : fallback(),
});
