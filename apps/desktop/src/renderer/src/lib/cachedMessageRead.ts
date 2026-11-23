import { comparableMessages, contentVersion } from '../../../shared/content_version';
import type { MessageReadWindow } from '../../../shared/message_read';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { client } from '../trpc/client';
import { toMessageWire } from '../views/workspace/messageProjection';
import type { MessageWire } from '../views/workspace/types';
import { cacheProcedureUnsupported } from './conditionalCache';
import { mergeRefreshedWindow } from './conversationRefresh';
import { IS_WEB } from './target.shared';

export async function readCachedMessageWindow(
  input: QQWriteBinding & {
    kind: 'c2c' | 'group';
    conv: string;
    sinceSeq: string;
    limit: number;
    readWindow: MessageReadWindow;
  },
  previous: MessageWire[],
): Promise<MessageWire[] | undefined> {
  if (
    !IS_WEB ||
    !previous.length ||
    previous.length > input.limit ||
    !/^[1-9]\d{0,19}$/.test(input.sinceSeq)
  )
    return undefined;
  try {
    const result = await client.remoteCache.messages.query({
      ...input,
      count: previous.length,
      version: contentVersion(comparableMessages(previous)),
    });
    if (result.kind === 'unchanged') return previous;
    const rows = result.rows.map(toMessageWire);
    return result.kind === 'append'
      ? [...previous, ...rows]
      : mergeRefreshedWindow(previous, rows, input.limit);
  } catch (error) {
    if (!cacheProcedureUnsupported(error)) throw error;
    return undefined;
  }
}
