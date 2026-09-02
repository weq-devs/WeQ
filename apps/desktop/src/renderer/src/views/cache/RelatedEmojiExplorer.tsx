/**
 * Local related-emoji (关联表情) resource browser (a category of the cache view).
 *
 * QQ NT keeps a keyword → emoji set under `nt_data/Emoji/emoji-related/emoji`:
 * `words.json` lists keywords, and each keyword that has emoji owns a dir named
 * `md5(keyword)` (UTF-8) full of plaintext gifs. The backend
 * (`account.relatedEmoji.*`) surfaces only keywords whose dir exists; here we
 * render one card per keyword — the first gif as the cover, the keyword as the
 * title — and open a lightbox with ALL of that keyword's gifs on click.
 *
 * Gif bytes never cross tRPC — the `<img>` points at `weq-media://relemoji`.
 */

import { useCallback, useState, type ReactElement } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { RelatedEmojiKeyword } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';
import { BlobDialog, CURSOR_PAGE, GridFooter, useCursorPaged } from './CacheShared';

/** weq-media URL for one related-emoji gif. */
function relemojiUrl(hash: string, file: string): string {
  return mediaUrl('relemoji', { hash, file });
}

export function RelatedEmojiExplorer(): ReactElement {
  const [preview, setPreview] = useState<RelatedEmojiKeyword | null>(null);
  const fetchPage = useCallback(
    (cursor: string | null) =>
      client.account.relatedEmoji.listKeywords.query({ limit: CURSOR_PAGE, cursor }),
    [],
  );
  const { entries, total, loading, error, done, sentinelRef } =
    useCursorPaged<RelatedEmojiKeyword>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (!loading && entries.length === 0 && done) {
    return <div className="weq-cache-grid-state">未找到关联表情资源</div>;
  }

  return (
    <div className="weq-cache-marketemoji">
      <div className="weq-cache-marketemoji-bar">
        <span className="weq-cache-data-name">关联表情</span>
        <span className="weq-cache-data-meta">
          {total ?? entries.length} 个关键词 · 点击查看该关键词的全部表情
        </span>
      </div>

      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-related-grid">
          {entries.map((entry) => (
            <RelatedEmojiCard key={entry.hash} entry={entry} onOpen={() => setPreview(entry)} />
          ))}
        </div>
        <GridFooter
          loading={loading}
          done={done}
          count={entries.length}
          sentinelRef={sentinelRef}
        />
      </div>

      {preview ? <RelatedEmojiLightbox entry={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** One keyword card: the first gif as cover + the keyword title. */
function RelatedEmojiCard({
  entry,
  onOpen,
}: {
  entry: RelatedEmojiKeyword;
  onOpen: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  const cover = entry.cover ? relemojiUrl(entry.hash, entry.cover) : null;

  return (
    <button type="button" className="weq-cache-related-card" onClick={onOpen} title={entry.keyword}>
      <span className="weq-cache-related-cover">
        {broken || !cover ? (
          <ImageIcon size={24} strokeWidth={1.4} className="weq-cache-related-fallback" />
        ) : (
          <img
            src={cover}
            alt={entry.keyword}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
        {entry.gifCount > 1 ? <em className="weq-cache-related-count">{entry.gifCount}</em> : null}
      </span>
      <span className="weq-cache-related-word">{entry.keyword}</span>
    </button>
  );
}

/** Lightbox: every gif for a keyword, fetched on open. */
function RelatedEmojiLightbox({
  entry,
  onClose,
}: {
  entry: RelatedEmojiKeyword;
  onClose: () => void;
}): ReactElement {
  const gifs = trpc.account.relatedEmoji.listGifs.useQuery({ hash: entry.hash });
  const files = gifs.data ?? [];

  return (
    <BlobDialog
      dialogClass="weq-related-dialog"
      bodyClass="weq-related-panels"
      title={entry.keyword}
      meta={gifs.isLoading ? '加载中…' : `${files.length} 个表情`}
      onClose={onClose}
    >
      {gifs.isLoading ? (
        <div className="weq-cache-grid-state">加载中…</div>
      ) : files.length === 0 ? (
        <div className="weq-cache-grid-state">该关键词无可渲染的表情</div>
      ) : (
        files.map((file) => (
          <div key={file} className="weq-related-stage">
            <img src={relemojiUrl(entry.hash, file)} alt={file} draggable={false} />
          </div>
        ))
      )}
    </BlobDialog>
  );
}
