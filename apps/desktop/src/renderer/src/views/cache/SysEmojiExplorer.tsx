/**
 * Local system-emoji resource browser (the 系统表情 category of the cache view).
 *
 * QQ NT keeps its built-in animated faces under
 * `nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/<name>/{png,apng,lottie}`.
 * The backend (`account.sysEmoji.*`) reports which formats each face carries;
 * here we render a grid (default preview = APNG via `<img>`, falling back to the
 * static PNG) that pages in as it scrolls. Clicking a face opens a lightbox that
 * renders EVERY format the face has — PNG / APNG through `<img>`, Lottie through
 * lottie-web — "有几个渲染几个", each in its own labelled panel.
 *
 * When QQ's directory is missing (fresh install, cleaned cache, static account)
 * the faces can be fetched from the official CDN instead — the bar exposes a
 * 补全 button for that, and chat rendering backfills them one at a time anyway.
 *
 * Bytes stream through the existing `weq-asset://emoji/<name>/<fmt>/<file>`
 * protocol (see main/resource_protocol.ts) — nothing crosses tRPC but metadata.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { RefreshCw, Smile, Download } from 'lucide-react';
import type { SysEmojiEntry } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { emojiUrl } from '../../lib/resourceUrl';
import { useAppDialog } from '../../lib/dialogUtils';
import { BlobDialog, CURSOR_PAGE, GridFooter, useCursorPaged } from './CacheShared';

/** weq-asset URL for one face's file in a given format dir. */
function faceUrl(name: string, fmt: 'png' | 'apng' | 'lottie', file: string): string {
  return emojiUrl(name, fmt, file);
}

export function SysEmojiExplorer(): ReactElement {
  const dialog = useAppDialog();
  const [preview, setPreview] = useState<SysEmojiEntry | null>(null);
  const [filling, setFilling] = useState(false);

  const fetchPage = useCallback(
    (cursor: string | null) =>
      client.account.sysEmoji.listEntries.query({ limit: CURSOR_PAGE, cursor }),
    [],
  );
  const { entries, total, loading, error, done, sentinelRef, reload } =
    useCursorPaged<SysEmojiEntry>(fetchPage);

  // How many faces the CDN could still supply — drives the 补全 button's copy.
  const statusQuery = trpc.account.sysEmoji.downloadStatus.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const status = statusQuery.data;
  const missing = status ? Math.max(0, status.available - status.present) : 0;

  /** Fetch every missing face, then restart paging so the grid picks them up. */
  const fillMissing = useCallback(async (): Promise<void> => {
    setFilling(true);
    try {
      const result = await client.account.sysEmoji.downloadAll.mutate();
      await Promise.all([statusQuery.refetch(), reload()]);
      dialog.success(
        '系统表情补全完成',
        `新下载 ${result.downloaded} 个，已有 ${result.skipped} 个` +
          (result.failed > 0 ? `，失败 ${result.failed} 个` : ''),
      );
    } catch (e) {
      dialog.error('系统表情补全失败', e instanceof Error ? e.message : String(e));
    } finally {
      setFilling(false);
    }
  }, [dialog, statusQuery, reload]);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }

  return (
    <div className="weq-cache-sysemoji">
      <div className="weq-cache-sysemoji-bar">
        <span className="weq-cache-data-name">系统表情</span>
        <span className="weq-cache-data-meta">
          {total ?? entries.length} 个 · 默认动图(APNG)预览，点击查看全部格式
          {status && !status.qqRoot ? ' · QQ 资源目录缺失，已改用下载补全' : ''}
          {status?.usingFallback ? ' · emoji.db 无表情数据，用内置地址表兜底' : ''}
        </span>
        {missing > 0 ? (
          <button
            type="button"
            className="weq-cache-sysemoji-fill"
            onClick={() => void fillMissing()}
            disabled={filling}
            title="从官方 CDN 下载缺失的内置表情"
          >
            {filling ? <RefreshCw size={13} className="is-spin" /> : <Download size={13} />}
            {filling ? '补全中…' : `补全 ${missing} 个`}
          </button>
        ) : null}
      </div>

      {!loading && entries.length === 0 && done ? (
        <div className="weq-cache-grid-state">
          {missing > 0 ? '本地没有系统表情资源，可点击上方补全下载' : '未找到系统表情资源'}
        </div>
      ) : (
        <div className="weq-cache-avatar-scroll">
          <div className="weq-cache-sysemoji-grid">
            {entries.map((entry) => (
              <SysEmojiCard key={entry.name} entry={entry} onOpen={() => setPreview(entry)} />
            ))}
          </div>
          <GridFooter
            loading={loading}
            done={done}
            count={entries.length}
            sentinelRef={sentinelRef}
          />
        </div>
      )}

      {preview ? <SysEmojiLightbox entry={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** One grid card: prefers the APNG, falls back to the static PNG. */
function SysEmojiCard({
  entry,
  onOpen,
}: {
  entry: SysEmojiEntry;
  onOpen: () => void;
}): ReactElement {
  // Prefer the animated APNG; fall back to the static PNG when it fails / absent.
  const initial: 'apng' | 'png' = entry.hasApng && entry.apngFile ? 'apng' : 'png';
  const [fmt, setFmt] = useState<'apng' | 'png'>(initial);
  const [broken, setBroken] = useState(false);

  const file = fmt === 'apng' ? entry.apngFile : entry.pngFile;
  const badges = formatBadges(entry);

  return (
    <button type="button" className="weq-cache-sysemoji-card" onClick={onOpen} title={entry.name}>
      <span className="weq-cache-sysemoji-thumb">
        {broken || !file ? (
          <Smile size={26} strokeWidth={1.4} className="weq-cache-sysemoji-fallback" />
        ) : (
          <img
            src={faceUrl(entry.name, fmt, file)}
            alt={entry.name}
            loading="lazy"
            draggable={false}
            onError={() => {
              if (fmt === 'apng' && entry.hasPng && entry.pngFile) setFmt('png');
              else setBroken(true);
            }}
          />
        )}
      </span>
      <span className="weq-cache-sysemoji-name">{entry.name}</span>
      <span className="weq-cache-sysemoji-badges">
        {badges.map((b) => (
          <em key={b} className="weq-cache-sysemoji-badge">
            {b}
          </em>
        ))}
      </span>
    </button>
  );
}

/** Lightbox: render every format the face carries, each in its own panel. */
function SysEmojiLightbox({
  entry,
  onClose,
}: {
  entry: SysEmojiEntry;
  onClose: () => void;
}): ReactElement {
  const panels: Array<{ fmt: 'png' | 'apng' | 'lottie'; file: string; label: string }> = [];
  if (entry.hasApng && entry.apngFile) {
    panels.push({ fmt: 'apng', file: entry.apngFile, label: 'APNG 动图' });
  }
  if (entry.hasLottie && entry.lottieFile) {
    panels.push({ fmt: 'lottie', file: entry.lottieFile, label: 'Lottie 动画' });
  }
  if (entry.hasPng && entry.pngFile) {
    panels.push({ fmt: 'png', file: entry.pngFile, label: '静态 PNG' });
  }

  // When a Lottie is present it becomes the hero: rendered large and centered,
  // with the APNG / PNG shrunk to flank it. `has-lottie` drives that layout.
  const hasLottie = panels.some((p) => p.fmt === 'lottie');

  return (
    <BlobDialog
      dialogClass={`weq-sysemoji-dialog${hasLottie ? ' has-lottie' : ''}`}
      bodyClass="weq-sysemoji-panels"
      title={`系统表情 · ${entry.name}`}
      meta={`${panels.length} 种格式`}
      onClose={onClose}
    >
      {panels.length === 0 ? (
        <div className="weq-cache-grid-state">该表情无可渲染的资源</div>
      ) : (
        panels.map((p) => (
          <figure key={p.fmt} className={`weq-sysemoji-panel is-${p.fmt}`}>
            <div className="weq-sysemoji-stage">
              {p.fmt === 'lottie' ? (
                <SysEmojiLottie src={faceUrl(entry.name, 'lottie', p.file)} label={entry.name} />
              ) : (
                <img
                  src={faceUrl(entry.name, p.fmt, p.file)}
                  alt={`${entry.name} ${p.label}`}
                  draggable={false}
                />
              )}
            </div>
            <figcaption className="weq-sysemoji-panel-cap">
              <strong>{p.label}</strong>
              <span>{p.file}</span>
            </figcaption>
          </figure>
        ))
      )}
    </BlobDialog>
  );
}

/**
 * Lottie player for the lightbox — mirrors the chat FaceEmoji approach:
 * `lottie_light` (no eval, CSP-safe) + svg renderer, looping. Falls back to a
 * muted note if the JSON can't be fetched / parsed.
 */
function SysEmojiLottie({ src, label }: { src: string; label: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let destroyed = false;
    let anim: import('lottie-web').AnimationItem | undefined;
    setFailed(false);

    void (async () => {
      try {
        const [{ default: lottie }, res] = await Promise.all([
          import('lottie-web/build/player/lottie_light'),
          fetch(src),
        ]);
        if (!res.ok) throw new Error(`lottie fetch ${res.status}`);
        const data = (await res.json()) as unknown;
        if (destroyed || !containerRef.current) return;
        anim = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          animationData: data,
        });
      } catch {
        if (!destroyed) setFailed(true);
      }
    })();

    return () => {
      destroyed = true;
      anim?.destroy();
    };
  }, [src]);

  if (failed) return <div className="weq-sysemoji-lottie-fail">Lottie 加载失败</div>;
  return <div ref={containerRef} className="weq-sysemoji-lottie" role="img" aria-label={label} />;
}

/** Short format badges for a card (APNG / Lottie / PNG), in render-priority order. */
function formatBadges(entry: SysEmojiEntry): string[] {
  const out: string[] = [];
  if (entry.hasApng) out.push('APNG');
  if (entry.hasLottie) out.push('Lottie');
  if (entry.hasPng) out.push('PNG');
  return out;
}
