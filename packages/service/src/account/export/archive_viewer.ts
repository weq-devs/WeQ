import {
  latestArchiveRecords,
  object,
  type Archive,
  type ArchiveRecord,
  type Json,
  type JsonObject,
} from './archive';
import { scanArchiveFile, streamArchiveEvents } from './archive_stream';

const text = (value: Json | undefined): string => (typeof value === 'string' ? value : '');
function displayActor(value: Json | undefined): string {
  const actor = object(value);
  if (typeof actor.name === 'string' && actor.name) return actor.name;
  return Array.isArray(actor.identities)
    ? actor.identities.map((identity) => text(object(identity).value)).join(' / ')
    : '';
}
function contentElements(
  content: Json | undefined,
  resources: Map<string, JsonObject>,
): JsonObject[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const element = object(value);
    if (element.type === 'text')
      return [{ type: 'text', data: { textContent: text(element.text) } }];
    if (element.type === 'mention')
      return [{ type: 'at', data: { textContent: `@${displayActor(element.actor)}` } }];
    if (element.type === 'media')
      return (Array.isArray(element.resourceIds) ? element.resourceIds : []).map((id) => {
        const resource = resources.get(String(id));
        const type =
          element.mediaType === 'image' || element.mediaType === 'sticker'
            ? 'pic'
            : element.mediaType === 'audio'
              ? 'ptt'
              : element.mediaType === 'video'
                ? 'video'
                : 'file';
        return {
          type,
          data: {
            fileName: text(element.caption) || text(resource?.name),
            ...(resource?.status === 'saved' ? { exportPath: resource.path! } : {}),
          },
        };
      });
    if (element.type === 'forward')
      return [
        {
          type: 'multiMsg',
          data: {
            forwardMessages: (Array.isArray(element.records) ? element.records : []).map((node) =>
              formalMessage(object(node), resources),
            ),
            status: element.status!,
          },
        },
      ];
    if (
      element.type === 'structured' &&
      typeof element.kind === 'string' &&
      element.kind.startsWith('qq.') &&
      object(element.value).type === 'json'
    )
      return [{ type: element.kind.slice(3), data: object(object(element.value).value) }];
    return [
      {
        type: 'text',
        data: {
          textContent:
            element.type === 'reference'
              ? text(element.quote) || `[引用：${text(element.status)}]`
              : element.type === 'unknown'
                ? `[未解析：${text(element.sourceType)}]`
                : JSON.stringify(element),
        },
      },
    ];
  });
}
function formalMessage(data: JsonObject, resources: Map<string, JsonObject>): JsonObject {
  return {
    msgId: text(data.messageId) || text(data.id),
    msgSeq: text(data.seq),
    sendTime: Number(object(data.sentAt).unixSeconds ?? 0),
    senderName: displayActor(data.sender),
    elements: contentElements(data.content, resources),
  };
}

function displayRecord(record: ArchiveRecord, resources: Map<string, JsonObject>): JsonObject {
  if (record.kind === 'message') return formalMessage(record.data, resources);
  const data = record.data;
  const elements = contentElements(data.content, resources);
  if (typeof data.subject === 'string')
    elements.unshift({ type: 'text', data: { textContent: data.subject } });
  if (Array.isArray(data.resourceIds))
    elements.push(
      ...contentElements(
        [
          {
            type: 'media',
            mediaType: data.type === 'photo' ? 'image' : data.type === 'video' ? 'video' : 'file',
            resourceIds: data.resourceIds,
          },
        ],
        resources,
      ),
    );
  if (!elements.length)
    elements.push({ type: 'text', data: { textContent: JSON.stringify(data) } });
  if (Array.isArray(data.process) && data.process.length)
    elements.push({ type: 'text', data: { textContent: JSON.stringify(data.process) } });
  return {
    msgId: record.id,
    msgSeq: '',
    sendTime: Number(object(data.sentAt ?? data.createdAt ?? data.collectedAt).unixSeconds ?? 0),
    senderName:
      displayActor(data.author ?? data.sender ?? data.owner ?? data.subject) || record.kind,
    elements,
  };
}

function incompleteContent(record: ArchiveRecord): boolean {
  if (record.state === 'deleted' || record.coverage.parsing === 'complete') return false;
  const content = record.data.content;
  return (
    Array.isArray(content) &&
    (!content.length || content.some((value) => object(value).type === 'unknown'))
  );
}

type ObservationRank = [bigint | null, number];
function rankObservation(value: JsonObject, order: number): ObservationRank {
  const seconds = object(value.observedAt).unixSeconds;
  if (typeof seconds !== 'string') return [null, order];
  const negative = seconds.startsWith('-'),
    [whole, fraction = ''] = (negative ? seconds.slice(1) : seconds).split('.');
  return [
    (BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, '0'))) * (negative ? -1n : 1n),
    order,
  ];
}
const later = (left: ObservationRank, right: ObservationRank) =>
  (left[0] !== null && (right[0] === null || left[0] > right[0])) ||
  (left[0] === right[0] && left[1] > right[1]);
export async function* streamArchiveViewerValues(
  path: string,
  format: 'json' | 'jsonl',
  signal?: AbortSignal,
): AsyncGenerator<JsonObject> {
  const scan = await scanArchiveFile(path, format, signal);
  const selection = object(object(object(scan.header.scope).selection).value);
  const conv =
    scan.conversations.size === 1
      ? [...scan.conversations.values()][0]!
      : { kind: selection.kind ?? 'unknown', id: selection.conv ?? '' };
  yield {
    _type: 'header',
    _viewerContainer: true,
    meta: {
      platform: 'qq',
      name: conv.name ?? '',
      conversationId: conv.id ?? '',
      kind: conv.kind ?? 'unknown',
      ...(scan.state.uncommittedTail
        ? { notice: '归档尾部存在未提交内容，当前仅显示已提交数据。' }
        : {}),
    },
  };
  for await (const event of streamArchiveEvents(path, format, { ...scan.state }, signal)) {
    if (event.type !== 'revision') continue;
    const record = event.value;
    if (scan.latest.get(record.id)?.revision !== record.revision) continue;
    let displayed = record;
    if (incompleteContent(record)) {
      let candidate: ArchiveRecord | undefined,
        priority: ObservationRank = [null, -1];
      for await (const previous of streamArchiveEvents(path, format, { ...scan.state }, signal)) {
        if (
          previous.type !== 'revision' ||
          previous.value.id !== record.id ||
          incompleteContent(previous.value) ||
          previous.value.state === 'deleted'
        )
          continue;
        const observations =
          scan.observations.get(`${previous.value.id}\0${previous.value.revision}`) ?? [];
        for (const observation of observations) {
          const rank = rankObservation(
            observation,
            scan.observationOrder.get(String(observation.id))!,
          );
          if (later(rank, priority)) {
            candidate = previous.value;
            priority = rank;
          }
        }
      }
      if (candidate)
        displayed = { ...record, data: { ...record.data, content: candidate.data.content! } };
    }
    const message = displayRecord(displayed, scan.resources);
    if (displayed !== record)
      (message.elements as Json[]).unshift({
        type: 'text',
        data: { textContent: '[最新观察正文不完整，显示已有版本] ' },
      });
    message.msgId = record.kind === 'message' ? (record.data.messageId ?? record.id) : record.id;
    if (record.state === 'deleted')
      (message.elements as Json[]).unshift({
        type: 'text',
        data: { textContent: '[已删除或撤回] ' },
      });
    yield message;
  }
}
/** 仅供显示的派生投影，不参与归档重写。资源按追加顺序保留最近一次成功。 */
export function archiveViewerValues(archive: Archive): JsonObject[] {
  const resources = new Map<string, JsonObject>();
  for (const receipt of archive.resources)
    if (receipt.status === 'saved' || !resources.has(String(receipt.id)))
      resources.set(String(receipt.id), receipt);
  const records = latestArchiveRecords(archive);
  const conversations = new Map(
    records.map((record) => {
      const conv = object(record.data.conversation);
      return [`${conv.kind}:${conv.id}`, conv];
    }),
  );
  const conv = conversations.size === 1 ? [...conversations.values()][0]! : {};
  const selection = object(object(archive.scope.selection).value);
  const fallback = object(selection.conversation);
  const metadata = Object.keys(conv).length ? conv : fallback;
  const header: JsonObject = {
    _type: 'header',
    _viewerContainer: true,
    meta: {
      platform: 'qq',
      name: metadata.name ?? '',
      conversationId: metadata.id ?? selection.conv ?? '',
      kind: metadata.kind === 'group' || selection.kind === 'group' ? 'group' : 'c2c',
    },
  };
  return [
    header,
    ...records.map((record) => {
      let displayed = record;
      if (incompleteContent(record)) {
        const revisions = new Map(
          archive.records
            .filter(
              (value) =>
                value.id === record.id && !incompleteContent(value) && value.state !== 'deleted',
            )
            .map((value) => [value.revision, value]),
        );
        let candidate: ArchiveRecord | undefined,
          priority: ObservationRank = [null, -1];
        for (const [order, observation] of archive.observations.entries()) {
          if (observation.recordId !== record.id || !revisions.has(String(observation.revision)))
            continue;
          const rank = rankObservation(observation, order);
          if (later(rank, priority)) {
            candidate = revisions.get(String(observation.revision));
            priority = rank;
          }
        }
        if (candidate)
          displayed = { ...record, data: { ...record.data, content: candidate.data.content! } };
      }
      const message = displayRecord(displayed, resources);
      if (displayed !== record)
        (message.elements as Json[]).unshift({
          type: 'text',
          data: { textContent: '[最新观察正文不完整，显示已有版本] ' },
        });
      message.msgId = record.data.messageId ?? record.id;
      if (record.state === 'deleted')
        (message.elements as Json[]).unshift({
          type: 'text',
          data: { textContent: '[已删除或撤回] ' },
        });
      return message;
    }),
  ];
}
