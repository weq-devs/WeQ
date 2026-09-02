/**
 * Local custom-emoji resource browser (the 自定义表情 category of the cache view).
 *
 * QQ NT caches custom emoji under `nt_data/Emoji` in two trees, exposed here as
 * scope tabs:
 *   - 搜到的表情 (`recv`)  — `emoji-recv/<YYYY-MM>/{Ori,Thumb}`, received emoji.
 *   - 我的表情   (`personal`) — `personal_emoji/{Ori,Thumb}`, own / favourited.
 *
 * The backend (`account.customEmoji.*`) merges each hash's `Ori` (original —
 * jpg/gif/png, extension unreliable) + `Thumb` (still PNG preview) into one
 * {@link CustomEmojiEntry}. Here we render a grid, one card per hash: the card
 * shows the THUMB (falling back to the original via `<img onError>`) and labels
 * which files exist — ori / thumb, 有什么打什么. Clicking opens a lightbox that
 * renders every available file side-by-side (the original at full size).
 *
 * Image bytes never cross tRPC — the `<img>` points at `weq-media://cemoji`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Search, Star } from 'lucide-react';
import type {
  CustomEmojiEntry,
  CustomEmojiScope,
  CustomEmojiScopeInfo,
  CustomEmojiVariant,
} from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';
import { BlobDialog, CURSOR_PAGE, fmtBytes, GridFooter, useCursorPaged } from './CacheShared';

const SCOPE_META: Record<CustomEmojiScope, { label: string; icon: ReactElement }> = {
  recv: { label: '收到的表情', icon: <Search size={14} /> },
  personal: { label: '我的表情', icon: <Star size={14} /> },
};

/** weq-media URL for one custom-emoji file, or null when that variant is absent. */
function cemojiSrc(
  scope: CustomEmojiScope,
  entry: CustomEmojiEntry,
  variant: CustomEmojiVariant,
): string | null {
  // The extension / `_size` suffix are unpredictable, so we address the exact
  // on-disk file name from the listing rather than reconstructing it.
  const file = variant === 'ori' ? entry.oriFile : entry.thumbFile;
  if (!file) return null;
  return mediaUrl('cemoji', {
    scope,
    bucket: entry.bucket,
    v: variant,
    file,
  });
}

export function CustomEmojiExplorer(): ReactElement {
  const scopes = trpc.account.customEmoji.listScopes.useQuery();
  const scopeList = useMemo<CustomEmojiScopeInfo[]>(
    () => (scopes.data ?? []) as CustomEmojiScopeInfo[],
    [scopes.data],
  );
  // Scopes that actually exist on disk (hide empty ones, but keep `recv` as a
  // landing tab while the scan is in flight).
  const presentScopes = useMemo(
    () => scopeList.filter((s) => s.present && s.count > 0),
    [scopeList],
  );

  const [active, setActive] = useState<CustomEmojiScope>('recv');

  // Auto-select the first present scope once the summary lands (if the current
  // one turned out empty).
  useEffect(() => {
    if (presentScopes.length === 0) return;
    if (!presentScopes.some((s) => s.scope === active)) {
      setActive(presentScopes[0]!.scope);
    }
  }, [presentScopes, active]);

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-tabs">
        {(presentScopes.length > 0 ? presentScopes : scopeList).map((s) => (
          <button
            key={s.scope}
            type="button"
            className={`weq-cache-avatar-tab${s.scope === active ? ' is-on' : ''}`}
            onClick={() => setActive(s.scope)}
            disabled={s.present && s.count === 0}
          >
            {SCOPE_META[s.scope].icon}
            <span>{SCOPE_META[s.scope].label}</span>
            <em className="weq-cache-avatar-tabcount">{s.count}</em>
          </button>
        ))}
        {scopes.isLoading && scopeList.length === 0 ? (
          <span className="weq-cache-avatar-loading">扫描表情缓存中…</span>
        ) : null}
      </div>

      <CustomEmojiGrid key={active} scope={active} />
    </div>
  );
}

/** Paged, lazy-loading grid for one scope. Remounted (via key) on scope change. */
function CustomEmojiGrid({ scope }: { scope: CustomEmojiScope }): ReactElement {
  const [preview, setPreview] = useState<CustomEmojiEntry | null>(null);
  const fetchPage = useCallback(
    (cursor: string | null) =>
      client.account.customEmoji.listEntries.query({ scope, limit: CURSOR_PAGE, cursor }),
    [scope],
  );
  const { entries, loading, error, done, sentinelRef } =
    useCursorPaged<CustomEmojiEntry>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (!loading && entries.length === 0 && done) {
    return <div className="weq-cache-grid-state">该分类暂无表情缓存</div>;
  }

  return (
    <div className="weq-cache-avatar-scroll">
      <div className="weq-cache-customemoji-grid">
        {entries.map((entry) => (
          <CustomEmojiCard
            key={`${entry.bucket}:${entry.hash}`}
            scope={scope}
            entry={entry}
            onOpen={() => setPreview(entry)}
          />
        ))}
      </div>
      <GridFooter loading={loading} done={done} count={entries.length} sentinelRef={sentinelRef} />

      {preview ? (
        <CustomEmojiLightbox scope={scope} entry={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}

/** One merged emoji: shows the thumb (falls back to the original), tags files. */
function CustomEmojiCard({
  scope,
  entry,
  onOpen,
}: {
  scope: CustomEmojiScope;
  entry: CustomEmojiEntry;
  onOpen: () => void;
}): ReactElement {
  // Prefer the still thumb for the grid; if it's missing or fails, show the ori.
  const [variant, setVariant] = useState<CustomEmojiVariant>(entry.hasThumb ? 'thumb' : 'ori');
  const [broken, setBroken] = useState(false);
  const badges = formatBadges(entry);
  const url = cemojiSrc(scope, entry, variant);

  return (
    <button
      type="button"
      className="weq-cache-customemoji-card"
      onClick={onOpen}
      title={entry.hash}
    >
      <span className="weq-cache-customemoji-thumb">
        {broken || !url ? (
          <span className="weq-cache-customemoji-fallback">?</span>
        ) : (
          <img
            src={url}
            alt={entry.hash}
            loading="lazy"
            draggable={false}
            onError={() => {
              // Thumb failed → try the original once, then give up.
              if (variant === 'thumb' && entry.hasOri) setVariant('ori');
              else setBroken(true);
            }}
          />
        )}
      </span>
      <span className="weq-cache-customemoji-hash">{entry.hash.slice(0, 8)}</span>
      <span className="weq-cache-customemoji-badges">
        {badges.map((b) => (
          <em key={b} className="weq-cache-customemoji-badge">
            {b}
          </em>
        ))}
      </span>
    </button>
  );
}

/** Lightbox: render every file the emoji has — original / thumb, each in a panel. */
function CustomEmojiLightbox({
  scope,
  entry,
  onClose,
}: {
  scope: CustomEmojiScope;
  entry: CustomEmojiEntry;
  onClose: () => void;
}): ReactElement {
  const panels: Array<{ variant: CustomEmojiVariant; label: string; size: number }> = [];
  if (entry.hasOri) {
    panels.push({
      variant: 'ori',
      label: `原图${entry.oriExt ? ` (${entry.oriExt.slice(1).toUpperCase()})` : ''}`,
      size: entry.oriBytes,
    });
  }
  if (entry.hasThumb) {
    panels.push({ variant: 'thumb', label: '缩略图 (PNG)', size: entry.thumbBytes });
  }

  return (
    <BlobDialog
      dialogClass="weq-marketemoji-dialog"
      bodyClass="weq-marketemoji-panels"
      title={`自定义表情 · ${entry.hash.slice(0, 12)}`}
      meta={`${entry.bucket ? `${entry.bucket} · ` : ''}${panels.length} 个文件`}
      onClose={onClose}
    >
      {panels.length === 0 ? (
        <div className="weq-cache-grid-state">该表情无可渲染的资源</div>
      ) : (
        panels.map((p) => (
          <figure key={p.variant} className="weq-marketemoji-panel">
            <div className="weq-marketemoji-stage">
              <img
                src={cemojiSrc(scope, entry, p.variant) ?? undefined}
                alt={`${entry.hash} ${p.label}`}
                draggable={false}
              />
            </div>
            <figcaption className="weq-marketemoji-panel-cap">
              <strong>{p.label}</strong>
              <span>{fmtBytes(p.size)}</span>
            </figcaption>
          </figure>
        ))
      )}
    </BlobDialog>
  );
}

/** Short file badges for a card (ori / thumb), in render-priority order. */
function formatBadges(entry: CustomEmojiEntry): string[] {
  const out: string[] = [];
  if (entry.hasOri) out.push('ori');
  if (entry.hasThumb) out.push('thumb');
  return out;
}
