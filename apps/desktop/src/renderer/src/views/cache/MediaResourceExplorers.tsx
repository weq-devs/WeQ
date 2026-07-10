/**
 * Browsers for the four local media caches in the 本地资源 (cache) view:
 *
 *   - {@link FlatMediaExplorer}  — 图片墙 (PhotoWall) / QQ空间缓存 (Qzone): flat
 *     hash caches, rendered as a plain image grid (click → image lightbox).
 *   - {@link MonthMediaExplorer} — 图片 (Pic) / 视频 (Video): month-bucketed
 *     Ori+Thumb caches, rendered avatar-style with a 原图/缩略图 source badge.
 *     Images open in the image lightbox; videos with an on-disk original play in
 *     the video lightbox (a ▶ overlay marks the playable ones).
 *   - {@link VoiceExplorer}     — 语音 (Ptt): month-bucketed SILK clips, rendered
 *     as cards with a (simulated) waveform + duration + play/pause. Clicking
 *     decodes the SILK to WAV via `weq-media://localvoice` and plays it; only one
 *     clip plays at a time.
 *
 * All share {@link useCursorPaged}, a cursor-based infinite-scroll loader (the
 * backend pages by bucket, so a cursor — not an offset — resumes the walk). All
 * image/video bytes stream via `weq-media://localmedia`; nothing crosses tRPC but
 * metadata. Reuses the avatar browser's grid CSS (`weq-cache-avatar-*`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { RefreshCw, Play, Pause } from 'lucide-react';
import type { FlatMediaEntry, MonthMediaEntry, VoiceMediaEntry } from '@weq/service';
import { client } from '../../trpc/client';
import { localMediaUrl, localVoiceUrl } from '../../lib/resourceUrl';
import { openLightbox } from '../../components/ImageLightbox';
import { openVideoLightbox } from '../../components/VideoLightbox';
import { fmtBytes } from './FileResourceShared';

const PAGE = 120;

type FlatKind = 'photoWall' | 'qzone';
type MonthKind = 'pic' | 'video';

// ── shared cursor-paged infinite scroll ─────────────────────────────────────────

interface CursorPage<T> {
  entries: T[];
  nextCursor: string | null;
}

interface CursorPaged<T> {
  entries: T[];
  loading: boolean;
  error: string | null;
  done: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Cursor-based infinite-scroll loader. `fetchPage(cursor)` pulls one page; the
 * sentinel auto-loads the next as it scrolls into view. Not filter-aware — each
 * kind mounts its own grid (via `key`), so there's nothing to reset.
 */
function useCursorPaged<T>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>,
): CursorPaged<T> {
  const [entries, setEntries] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cursorRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchRef.current(cursorRef.current);
      setEntries((prev) => [...prev, ...page.entries]);
      cursorRef.current = page.nextCursor;
      if (page.nextCursor === null) {
        doneRef.current = true;
        setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      doneRef.current = true; // stop the sentinel from hammering a failing kind
      setDone(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  // First page on mount.
  useEffect(() => {
    void loadMore();
  }, [loadMore]);

  // Auto-load the next page as the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done) return undefined;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting)) void loadMore();
      },
      { rootMargin: '500px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done, entries.length]);

  return { entries, loading, error, done, sentinelRef };
}

/** Footer row for a media grid (sentinel / loading / end state). */
function GridFooter({
  loading,
  done,
  count,
  sentinelRef,
}: {
  loading: boolean;
  done: boolean;
  count: number;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}): ReactElement {
  if (done) {
    return (
      <div className="weq-cache-avatar-more is-end">
        {count === 0 ? '该分类暂无缓存' : `已全部加载（${count}）`}
      </div>
    );
  }
  return (
    <div ref={sentinelRef} className="weq-cache-avatar-more">
      <RefreshCw size={14} className={loading ? 'is-spin' : ''} />
      {loading ? '加载中…' : '滚动加载更多'}
    </div>
  );
}

// ── 图片墙 / QQ空间 (flat hash grid) ────────────────────────────────────────────

/** Flat image grid for a hex-bucketed cache (图片墙 / QQ空间缓存). */
export function FlatMediaExplorer({ kind }: { kind: FlatKind }): ReactElement {
  const fetchPage = useCallback(
    (cursor: string | null) =>
      client.account.mediaResource.listFlat.query({ kind, cursor, limit: PAGE }),
    [kind],
  );
  const { entries, loading, error, done, sentinelRef } = useCursorPaged<FlatMediaEntry>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-avatar-grid">
          {entries.map((entry) => (
            <FlatCard key={entry.rel} kind={kind} entry={entry} />
          ))}
        </div>
        <GridFooter loading={loading} done={done} count={entries.length} sentinelRef={sentinelRef} />
      </div>
    </div>
  );
}

/** One flat cache image (click → image lightbox). */
function FlatCard({ kind, entry }: { kind: FlatKind; entry: FlatMediaEntry }): ReactElement {
  const src = localMediaUrl(kind, entry.rel);
  return (
    <figure className="weq-cache-avatar-card" title={entry.name}>
      <button
        type="button"
        className="weq-cache-avatar-thumb weq-cache-media-open"
        onClick={() => openLightbox(src, entry.name)}
      >
        <img src={src} alt={entry.name} loading="lazy" />
      </button>
      <figcaption className="weq-cache-avatar-meta">
        <span className="weq-cache-avatar-hash">{entry.name.slice(0, 10)}…</span>
        <span className="weq-cache-avatar-size">{fmtBytes(entry.size)}</span>
      </figcaption>
    </figure>
  );
}

// ── 图片 / 视频 (month, Ori + Thumb) ────────────────────────────────────────────

/** Avatar-style month grid for a Pic / Video cache with a 原图/缩略图 badge. */
export function MonthMediaExplorer({ kind }: { kind: MonthKind }): ReactElement {
  const fetchPage = useCallback(
    (cursor: string | null) =>
      client.account.mediaResource.listMonth.query({ kind, cursor, limit: PAGE }),
    [kind],
  );
  const { entries, loading, error, done, sentinelRef } = useCursorPaged<MonthMediaEntry>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-avatar-grid">
          {entries.map((entry) => (
            <MonthCard key={`${entry.month}:${entry.hash}`} kind={kind} entry={entry} />
          ))}
        </div>
        <GridFooter loading={loading} done={done} count={entries.length} sentinelRef={sentinelRef} />
      </div>
    </div>
  );
}

/**
 * One Pic/Video item. Shows the thumbnail (falling back to the original for
 * images), a 原图/缩略图/原图+缩略图 source badge, and — for a video with an
 * on-disk original — a ▶ overlay that opens the video lightbox.
 */
function MonthCard({ kind, entry }: { kind: MonthKind; entry: MonthMediaEntry }): ReactElement {
  const isVideo = kind === 'video';
  // Grid preview: thumbnail first (fast), else the original (images only — a
  // video original can't render as an <img>).
  const previewRel = entry.thumbRel ?? (isVideo ? null : entry.oriRel);
  const previewSrc = previewRel ? localMediaUrl(kind, previewRel) : null;

  const source = sourceLabel(entry, isVideo);
  const totalBytes = entry.oriBytes + entry.thumbBytes;
  // Playable when it's a video whose original is on disk.
  const playable = isVideo && entry.hasOri && entry.oriRel;

  const onOpen = (): void => {
    if (playable) {
      openVideoLightbox(localMediaUrl(kind, entry.oriRel!), previewSrc ?? undefined);
    } else if (!isVideo) {
      // Image: prefer the original in the lightbox, fall back to the thumbnail.
      const full = entry.oriRel ?? entry.thumbRel;
      if (full) openLightbox(localMediaUrl(kind, full), entry.hash);
    }
  };
  const clickable = playable || (!isVideo && (entry.oriRel || entry.thumbRel));

  return (
    <figure className="weq-cache-avatar-card" title={entry.hash}>
      <button
        type="button"
        className="weq-cache-avatar-thumb weq-cache-media-open"
        onClick={clickable ? onOpen : undefined}
        disabled={!clickable}
      >
        {previewSrc ? (
          <img src={previewSrc} alt={entry.hash} loading="lazy" />
        ) : (
          <span className="weq-cache-media-noimg">无缩略图</span>
        )}
        {playable ? (
          <span className="weq-cache-media-play" aria-hidden>
            <Play size={20} fill="currentColor" />
          </span>
        ) : null}
        <span className={`weq-cache-avatar-src is-${source.tone}`}>{source.text}</span>
      </button>
      <figcaption className="weq-cache-avatar-meta">
        <span className="weq-cache-avatar-hash">{entry.month}</span>
        <span className="weq-cache-avatar-size">{fmtBytes(totalBytes)}</span>
      </figcaption>
    </figure>
  );
}

/** Which variants exist → a source badge (text + tone). Video says 原视频. */
function sourceLabel(
  entry: MonthMediaEntry,
  isVideo: boolean,
): { text: string; tone: 'both' | 'big' | 'small' } {
  const ori = isVideo ? '原视频' : '原图';
  if (entry.hasOri && entry.hasThumb) return { text: `${ori}+缩略图`, tone: 'both' };
  if (entry.hasOri) return { text: ori, tone: 'big' };
  return { text: '缩略图', tone: 'small' };
}

// ── 语音 (Ptt, SILK clips) ──────────────────────────────────────────────────────

const WAVE_BARS = 34;
/** Rough SILK byte-rate for QQ voice; only used for a pre-play duration hint. */
const SILK_BYTES_PER_SEC = 1900;

/**
 * Module-level playback lock: only one voice clip plays at a time. Starting a new
 * clip stops whatever was playing (the previous card resets its own UI).
 */
let stopCurrentVoice: (() => void) | null = null;
function claimVoicePlayback(stop: () => void): void {
  if (stopCurrentVoice && stopCurrentVoice !== stop) stopCurrentVoice();
  stopCurrentVoice = stop;
}

/** Deterministic speech-like waveform (0..1 heights) seeded by the clip hash. */
function fakeWaveform(seedStr: string, count = WAVE_BARS): number[] {
  let seed = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i += 1) {
    seed = (seed ^ seedStr.charCodeAt(i)) >>> 0;
    seed = (seed * 0x01000193) >>> 0;
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const r = (seed >>> 8) / 0xffffff; // 0..1
    // Gentle envelope (louder in the middle) so it reads as a spoken clip.
    const env = 0.45 + 0.55 * Math.sin((i / (count - 1)) * Math.PI);
    bars.push(0.22 + r * 0.78 * env);
  }
  return bars;
}

/** Voice-clip grid for the Ptt cache (语音). */
export function VoiceExplorer(): ReactElement {
  const fetchPage = useCallback(
    (cursor: string | null) => client.account.mediaResource.listVoice.query({ cursor, limit: PAGE }),
    [],
  );
  const { entries, loading, error, done, sentinelRef } = useCursorPaged<VoiceMediaEntry>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }

  // Clips arrive newest-month-first and stay in month order, so a divider only
  // needs inserting whenever the month changes from the previous card.
  const nodes: ReactElement[] = [];
  let lastMonth = '';
  for (const entry of entries) {
    if (entry.month !== lastMonth) {
      lastMonth = entry.month;
      nodes.push(
        <div key={`sep-${entry.month}`} className="weq-voice-monthsep">
          <span>{entry.month}</span>
        </div>,
      );
    }
    nodes.push(<VoiceCard key={entry.rel} entry={entry} />);
  }

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-scroll">
        <div className="weq-voice-grid">{nodes}</div>
        <GridFooter loading={loading} done={done} count={entries.length} sentinelRef={sentinelRef} />
      </div>
    </div>
  );
}

/**
 * One voice clip: a simulated waveform + duration + play/pause. The SILK bytes
 * are decoded to WAV on demand (first play), and the real duration replaces the
 * byte-estimated one once the audio's metadata loads. Playback progress lights
 * up the waveform left-to-right.
 */
function VoiceCard({ entry }: { entry: VoiceMediaEntry }): ReactElement {
  const bars = useMemo(() => fakeWaveform(entry.hash), [entry.hash]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [realDur, setRealDur] = useState<number | null>(null);

  // Stop + drop the audio if the card is recycled to a different clip.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [entry.rel]);

  const toggle = (): void => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(localVoiceUrl(entry.rel));
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio!.duration) && audio!.duration > 0) {
          setRealDur(Math.max(1, Math.round(audio!.duration)));
        }
      };
      audio.ontimeupdate = () => {
        if (audio!.duration > 0) setProgress(audio!.currentTime / audio!.duration);
      };
      audio.onended = () => {
        setPlaying(false);
        setProgress(0);
      };
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      claimVoicePlayback(() => {
        audio!.pause();
        setPlaying(false);
      });
      void audio
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    }
  };

  const seconds = realDur ?? Math.min(60, Math.max(1, Math.round(entry.bytes / SILK_BYTES_PER_SEC)));
  const filled = Math.round(progress * bars.length);

  return (
    <figure className="weq-voice-card" title={entry.name}>
      <button
        type="button"
        className={`weq-voice-player${playing ? ' is-playing' : ''}`}
        onClick={toggle}
      >
        <span className="weq-voice-btn" aria-hidden>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </span>
        <span className="weq-voice-wave" aria-hidden>
          {bars.map((h, i) => (
            <i
              key={i}
              className={i < filled ? 'is-played' : ''}
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          ))}
        </span>
        <span className="weq-voice-dur">
          {seconds}
          <em>″</em>
        </span>
      </button>
      <figcaption className="weq-voice-meta">
        <span className="weq-voice-hash">{entry.hash.slice(0, 8)}…</span>
        <span className="weq-voice-size">{fmtBytes(entry.bytes)}</span>
      </figcaption>
    </figure>
  );
}
