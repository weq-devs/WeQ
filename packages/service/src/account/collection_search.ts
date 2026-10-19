import type { CollectionItem } from '@weq/db';
import { htmlPlainText } from '../common/html_text';

export interface CollectionSearchHit {
  category: 'collection';
  cid: string;
  kind: CollectionItem['kind'];
  title: string;
  content: string;
  sourceName: string;
  collectTime: number;
}

/** 摘要与已缓存的可读详情一起检索，不把未取得的正文当作已覆盖。 */
export function collectionSearchDocument(
  item: CollectionItem,
): Omit<CollectionSearchHit, 'category' | 'content'> & { text: string } {
  const summary = item.summary;
  const title =
    summary.linkSummary?.title ||
    summary.richMediaSummary?.title ||
    summary.richMediaSummary?.subTitle ||
    summary.videoSummary?.title ||
    summary.fileSummary?.fileInfo?.name ||
    summary.fileSummary?.srcFileInfo?.name ||
    summary.locationSummary?.name ||
    summary.textSummary?.text ||
    '收藏';
  const body = [
    summary.textSummary?.text,
    summary.linkSummary?.brief,
    summary.linkSummary?.publisher,
    summary.linkSummary?.url,
    summary.richMediaSummary?.brief,
    summary.richMediaSummary?.originalUri,
    summary.richMediaSummary?.publisher,
    summary.richMediaSummary?.subTitle,
    summary.fileSummary?.srcFileInfo?.name,
    summary.audioSummary?.stt,
    summary.videoSummary?.storeFileInfo?.name,
    summary.locationSummary?.address,
    summary.locationSummary?.note,
    item.cachedContent?.textContent?.data,
    item.cachedContent?.audioContent?.data,
    ...[
      ...(summary.gallerySummary?.picList ?? []),
      ...(summary.linkSummary?.picList ?? []),
      ...(summary.richMediaSummary?.picList ?? []),
      ...(item.cachedContent?.richMediaContent?.picList ?? []),
    ].flatMap((pic) => [pic.name, pic.note]),
    ...(item.cachedContent?.richMediaContent?.fileList ?? []).map((file) => file.name),
    item.cachedContent?.richMediaContent?.rawData
      ? htmlPlainText(item.cachedContent.richMediaContent.rawData)
      : '',
  ].filter((value): value is string => Boolean(value));
  const sourceName = [item.author?.strId, item.author?.groupName].filter(Boolean).join(' · ');
  return {
    cid: item.cid,
    kind: item.kind,
    title,
    text: [...new Set([title, sourceName, ...body])].join('\n'),
    sourceName,
    collectTime: item.collectTime,
  };
}

export function searchCollectionItems(
  items: readonly CollectionItem[],
  keyword: string,
  offset: number,
  limit: number,
): { items: CollectionSearchHit[]; total: number } {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return { items: [], total: 0 };
  const hits: CollectionSearchHit[] = [];
  for (const item of items) {
    const document = collectionSearchDocument(item);
    const at = document.text.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 48);
    const end = Math.min(document.text.length, Math.max(start + 200, at + needle.length));
    hits.push({
      category: 'collection',
      cid: document.cid,
      kind: document.kind,
      title: document.title.slice(0, 200),
      sourceName: document.sourceName,
      collectTime: document.collectTime,
      content: `${start ? '…' : ''}${document.text.slice(start, end)}${end < document.text.length ? '…' : ''}`,
    });
  }
  hits.sort((a, b) => b.collectTime - a.collectTime || a.cid.localeCompare(b.cid));
  return { items: hits.slice(offset, offset + limit), total: hits.length };
}
