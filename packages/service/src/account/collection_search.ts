import type { CollectionItem } from '@weq/db';
import { createPinyinMatcher } from '@weq/codec/pinyin-search';
import { htmlPlainText } from '../common/html_text';

export interface CollectionSearchHit {
  category: 'collection';
  cid: string;
  kind: CollectionItem['kind'];
  title: string;
  content: string;
  sourceName: string;
  collectTime: number;
  matchRank?: number;
}

/** 摘要与已缓存的可读详情一起检索，不把未取得的正文当作已覆盖。 */
export function collectionSearchDocument(
  item: CollectionItem,
): Omit<CollectionSearchHit, 'category' | 'content'> & { text: string; names: string[] } {
  const summary = item.summary;
  const titles = [
    summary.linkSummary?.title,
    summary.richMediaSummary?.title,
    summary.richMediaSummary?.subTitle,
    summary.videoSummary?.title,
    summary.fileSummary?.fileInfo?.name,
    summary.fileSummary?.srcFileInfo?.name,
    summary.locationSummary?.name,
  ].filter((value): value is string => Boolean(value));
  const title = titles[0] || summary.textSummary?.text || '收藏';
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
  const sources = [item.author?.strId, item.author?.groupName].filter((value): value is string =>
    Boolean(value),
  );
  const sourceName = sources.join(' · ');
  return {
    cid: item.cid,
    kind: item.kind,
    title,
    text: [...new Set([title, sourceName, ...body])].join('\n'),
    sourceName,
    names: [
      ...titles,
      ...sources,
      summary.linkSummary?.publisher,
      summary.richMediaSummary?.publisher,
      summary.videoSummary?.storeFileInfo?.name,
    ].filter((value): value is string => Boolean(value)),
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
  const pinyin = createPinyinMatcher(needle);
  const hits: { hit: CollectionSearchHit; rank: number }[] = [];
  for (const item of items) {
    const document = collectionSearchDocument(item);
    const at = document.text.toLocaleLowerCase().indexOf(needle);
    const rank = at >= 0 ? 3 : (pinyin?.rank(...document.names) ?? 0);
    if (!rank) continue;
    const start = Math.max(0, at - 48);
    const end = Math.min(document.text.length, Math.max(start + 200, at + needle.length));
    hits.push({
      rank,
      hit: {
        category: 'collection',
        cid: document.cid,
        kind: document.kind,
        title: document.title.slice(0, 200),
        sourceName: document.sourceName,
        collectTime: document.collectTime,
        ...(at < 0 ? { matchRank: rank } : {}),
        content: `${start ? '…' : ''}${document.text.slice(start, end)}${end < document.text.length ? '…' : ''}`,
      },
    });
  }
  hits.sort(
    (a, b) =>
      b.rank - a.rank ||
      b.hit.collectTime - a.hit.collectTime ||
      a.hit.cid.localeCompare(b.hit.cid),
  );
  return { items: hits.slice(offset, offset + limit).map(({ hit }) => hit), total: hits.length };
}
