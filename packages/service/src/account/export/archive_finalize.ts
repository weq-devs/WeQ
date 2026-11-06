import { dirname } from 'node:path';
import {
  recordRevision,
  object,
  writeArchiveEntries,
  type ArchiveEntry,
  type ArchiveRecord,
  type JsonObject,
} from './archive';
import { scanArchiveFile, streamArchiveEvents } from './archive_stream';
import { archiveResource } from './archive_resource';
import { mediaRelPath } from './element_text';

/** 仅处理本轮尚未发布的正式产物，不回读 QQ，不重新请求转发/下载或模型。 */
export async function finalizeArchiveMessages(
  path: string,
  format: 'json' | 'jsonl',
  options: {
    media: boolean;
    transcripts?: Record<string, string>;
    ocr?: Record<string, { text?: string }>;
    signal?: AbortSignal;
    additionalEntries?: ArchiveEntry[];
  },
): Promise<void> {
  const scan = await scanArchiveFile(path, format, options.signal);
  const mediaTypes = new Map<string, string>();
  const inspect = (data: JsonObject) => {
    for (const value of Array.isArray(data.content) ? data.content : []) {
      const element = object(value);
      if (element.type === 'media')
        for (const id of element.resourceIds as string[])
          mediaTypes.set(id, String(element.mediaType));
      if (element.type === 'forward')
        for (const node of element.records as JsonObject[]) inspect(node);
    }
  };
  for await (const event of streamArchiveEvents(path, format, { ...scan.state }, options.signal))
    if (event.type === 'revision') inspect(event.value.data);
  const receipts: JsonObject[] = [];
  for (const receipt of scan.resources.values()) {
    const type = mediaTypes.get(String(receipt.id));
    const sourceType =
      type === 'image'
        ? 'pic'
        : type === 'audio'
          ? 'ptt'
          : type === 'video'
            ? 'video'
            : type === 'file'
              ? 'file'
              : '';
    const localPath =
      sourceType && typeof receipt.name === 'string'
        ? (mediaRelPath({ type: sourceType, data: { fileName: receipt.name } }) ?? undefined)
        : undefined;
    receipts.push(
      options.media ? await archiveResource(dirname(path), localPath, receipt) : receipt,
    );
  }
  const names = new Map(
    receipts.map((receipt) => [String(receipt.id), String(receipt.name ?? '')]),
  );
  const enrich = (data: JsonObject) => {
    for (const value of Array.isArray(data.content) ? data.content : []) {
      const element = object(value);
      if (element.type === 'forward')
        for (const node of element.records as JsonObject[]) enrich(node);
      if (element.type !== 'media') continue;
      const name = names.get(String((element.resourceIds as string[])[0]));
      if (!name) continue;
      const text =
        element.mediaType === 'audio'
          ? options.transcripts?.[name]
          : element.mediaType === 'image'
            ? options.ocr?.[name]?.text
            : undefined;
      if (text) element.caption = text;
    }
  };
  async function* entries(): AsyncGenerator<ArchiveEntry> {
    let first = true;
    for await (const event of streamArchiveEvents(
      path,
      format,
      { ...scan.state },
      options.signal,
    )) {
      if (event.type !== 'revision') continue;
      const record = structuredClone(event.value) as ArchiveRecord;
      enrich(record.data);
      record.revision = recordRevision(record);
      const observations = (
        scan.observations.get(`${event.value.id}\0${event.value.revision}`) ?? []
      ).map((observation) => ({ ...observation, revision: record.revision }));
      if (observations[0]) {
        yield {
          record,
          observation: observations[0],
          additionalObservations: observations.slice(1),
          resources: first ? receipts : [],
        };
        first = false;
      }
    }
    yield* options.additionalEntries ?? [];
  }
  await writeArchiveEntries(path, format, scan.header, entries());
}
