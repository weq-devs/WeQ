import { client } from '../trpc/client';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';

export type ProfilePreviewCursor = { time: number; rowId: string };

/** 浏览接口按时间和行号倒序分页；预览统一按旧到新展示，保留服务端游标。 */
export async function readProfilePreviewPage(input: {
  kind: 'c2c' | 'group';
  conv: string;
  sender?: string;
  cursor?: ProfilePreviewCursor;
  beforeSeq?: string;
  binding?: QQWriteBinding;
}) {
  const { kind, conv, sender, cursor, beforeSeq, binding } = input;
  if (sender) {
    const page = await client.account.browseConversation.query({
      ...binding,
      kind,
      conv,
      filter: { sender },
      cursor,
      limit: 50,
    });
    return {
      rows: [...page.items].reverse(),
      hasMore: page.hasMore,
      cursor: page.cursor ?? undefined,
    };
  }
  const rows = beforeSeq
    ? await client.account.listBefore.query({ ...binding, kind, conv, beforeSeq, limit: 50 })
    : await client.account.listLatest.query({ ...binding, kind, conv, limit: 50 });
  return { rows: [...rows].reverse(), hasMore: rows.length === 50, cursor: undefined };
}
