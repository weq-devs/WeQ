import type { ContentSearchRecord, ContentSearchStore } from './content_search';
import { publicRichText } from '../common/qzone_public_text';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number'
    ? String(value)
    : '';
const rows = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).flatMap((item) => (object(item) ? [object(item)!] : []));

/** 仅消费成功读取的实际字段，不为搜索补发请求或推测缺失身份。 */
export function contentReadingRecords(
  method: string,
  args: unknown[],
  value: unknown,
): ContentSearchRecord[] {
  if (method.startsWith('getQzonePublic')) {
    const feed = object(args[0]);
    const common = object(feed?.cell_common),
      union = object(common?.union_id);
    const feedKey = text(union?.uf_key ?? common?.feed_id ?? union?.feed_id);
    if (!feed || !union || !feedKey) return [];
    const minimal = {
      cell_common: { union_id: structuredClone(union) },
      ...(feed.cell_feed_transfer === undefined
        ? {}
        : { cell_feed_transfer: structuredClone(feed.cell_feed_transfer) }),
    };
    const result = object(value);
    const fullFeed = object(object(result?.feed)?.feed);
    const comments =
      method === 'getQzonePublicReplies'
        ? result?.replys
        : object((fullFeed ?? result)?.cell_comment)?.comments;
    const parentId = method === 'getQzonePublicReplies' ? text(object(args[1])?.id) : '';
    const records: ContentSearchRecord[] = [];
    const collect = (items: unknown, parent = '') => {
      for (const row of rows(items)) {
        const id = text(row.id),
          content = publicRichText(row.content);
        if (!id) continue;
        if (content)
          records.push({
            target: {
              kind: 'qzonePublicComment',
              feedKey,
              feed: minimal,
              commentId: id,
              ...(parent ? { parentCommentId: parent } : {}),
            },
            title: parent ? '空友回复' : '空友评论',
            content,
            sourceName: '空友爱看',
            time: Number(row.time ?? 0),
            detail: true,
          });
        if (!parent) collect(row.replys, id);
      }
    };
    collect(comments, parentId);
    return records;
  }
  const owner = text(args[0]);
  if (method === 'getGroupBulletins' || method === 'getGroupNotice')
    return rows(value).flatMap((row) => {
      const id = text(row.fid ?? row.noticeId);
      const content = text(row.textContent ?? row.text);
      return owner && id && content
        ? [
            {
              target: { kind: 'groupBulletin' as const, groupCode: owner, bulletinId: id },
              title: content.slice(0, 100),
              content,
              sourceName: `群 ${owner} · 公告`,
              time: Number(row.msgTime ?? row.publishTime ?? 0),
            },
          ]
        : [];
    });
  if (method === 'getEssenceMessagesWithContent' || method === 'getEssencePageWithContent')
    return rows(Array.isArray(value) ? value : object(value)?.messages).flatMap((row) => {
      const seq = text(row.msgSeq);
      const content = rows(row.content)
        .map((part) => text(part.text ?? part.fileName))
        .join(' ');
      return owner && /^[1-9]\d*$/.test(seq)
        ? [
            {
              target: { kind: 'groupEssence' as const, groupCode: owner, msgSeq: seq },
              title: `群精华 · ${text(row.senderNick) || seq}`,
              content,
              sourceName: `群 ${owner} · 精华`,
              time: Number(row.senderTime ?? row.operatorTime ?? 0),
            },
          ]
        : [];
    });
  if (method === 'listFiles')
    return rows(object(value)?.files).flatMap((row) => {
      const id = text(row.fileId),
        name = text(row.name);
      return owner && id && name
        ? [
            {
              target: {
                kind: 'flashFile' as const,
                filesetId: owner,
                parentId: text(args[1]),
                zipFileId: text(args[2]),
                fileId: id,
              },
              title: name,
              content: name,
              sourceName: 'QQ 闪传',
              time: 0,
            },
          ]
        : [];
    });
  const comments = (tid: string, value: unknown): ContentSearchRecord[] =>
    rows(object(value)?.comments).flatMap((row) => {
      const id = text(row.id),
        content = text(row.content);
      return owner && tid && id && content
        ? [
            {
              target: {
                kind: 'qzoneComment' as const,
                uin: owner,
                tid,
                commentId: id,
                ...(row.parentCommentId ? { parentCommentId: text(row.parentCommentId) } : {}),
                ...(row.replyId ? { replyId: text(row.replyId) } : {}),
              },
              title: `${text(row.nickname) || text(row.uin)} · ${row.isReply ? '回复' : '评论'}`,
              content,
              sourceName: `空间 ${owner}`,
              time: Number(row.time ?? 0),
              detail: true,
            },
          ]
        : [];
    });
  if (method === 'getQzoneStructuredComments') return comments(text(args[1]), value);
  if (method === 'getQzoneInteractions' && value instanceof Map)
    return [...value].flatMap(([tid, interaction]) => comments(text(tid), interaction));
  return [];
}

export function installContentSearchCapture(
  services: object,
  store: ContentSearchStore,
  current: () => boolean,
): () => void {
  const restores: Array<() => void> = [];
  const sources = {
    groupInfo: ['getGroupBulletins', 'getEssenceMessagesWithContent', 'getEssencePageWithContent'],
    webQuery: [
      'getGroupNotice',
      'getQzoneStructuredComments',
      'getQzoneInteractions',
      'getQzonePublicFeedDetail',
      'getQzonePublicComments',
      'getQzonePublicReplies',
    ],
    flashTransferFiles: ['listFiles'],
  };
  for (const [key, methods] of Object.entries(sources)) {
    const service: unknown = Reflect.get(services, key);
    if (!service || typeof service !== 'object') continue;
    for (const method of methods) {
      const original: unknown = Reflect.get(service, method);
      if (typeof original !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(service, method);
      const wrapped = async function (this: unknown, ...args: unknown[]) {
        const result: unknown = await Reflect.apply(original, this, args);
        if (current()) {
          try {
            store.remember(contentReadingRecords(method, args, result));
          } catch (error) {
            console.warn(
              '[content-search] 本次内容未加入索引',
              error instanceof Error ? error.name : 'unknown',
            );
          }
        }
        return result;
      };
      Reflect.set(service, method, wrapped);
      restores.push(() => {
        if (Reflect.get(service, method) !== wrapped) return;
        if (descriptor) Object.defineProperty(service, method, descriptor);
        else Reflect.deleteProperty(service, method);
      });
    }
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
