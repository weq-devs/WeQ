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
 *     clip plays at a time. With a transcription model configured, each card also
 *     offers 转文字.
 *
 * All share {@link useCursorPaged}, a cursor-based infinite-scroll loader (the
 * backend pages by bucket, so a cursor — not an offset — resumes the walk). All
 * image/video bytes stream via `weq-media://localmedia`; nothing crosses tRPC but
 * metadata. Reuses the avatar browser's grid CSS (`weq-cache-avatar-*`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Play, Pause, FileText, Loader2 } from 'lucide-react';
import type { FlatMediaEntry, MonthMediaEntry, VoiceMediaEntry } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { localMediaUrl, localVoiceUrl } from '../../lib/resourceUrl';
import { openLightbox } from '../../components/ImageLightbox';
import { openVideoLightbox } from '../../components/VideoLightbox';
import { ShimmerImage } from '../../components/ShimmerImage';
import { CURSOR_PAGE, fmtBytes, GridFooter, useCursorPaged } from './CacheShared';
import { GridSkeleton } from './CacheSkeleton';

type FlatKind = 'photoWall' | 'qzone';
type MonthKind = 'pic' | 'video';

// ── 图片墙 / QQ空间 (flat hash grid) ────────────────────────────────────────────

/** Flat image grid for a hex-bucketed cache (图片墙 / QQ空间缓存). */
export function FlatMediaExplorer({ kind }: { kind: FlatKind }): ReactElement {
  const fetchPage = useCallback(
    (cursor: string | null) =>
      client.account.mediaResource.listFlat.query({ kind, cursor, limit: CURSOR_PAGE }),
    [kind],
  );
  const { entries, loading, error, done, sentinelRef } = useCursorPaged<FlatMediaEntry>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (loading && entries.length === 0) {
    return <GridSkeleton />;
  }

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-avatar-grid">
          {entries.map((entry) => (
            <FlatCard key={entry.rel} kind={kind} entry={entry} />
          ))}
        </div>
        <GridFooter
          loading={loading}
          done={done}
          count={entries.length}
          sentinelRef={sentinelRef}
        />
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
        <ShimmerImage src={src} alt={entry.name} loading="lazy" />
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
      client.account.mediaResource.listMonth.query({ kind, cursor, limit: CURSOR_PAGE }),
    [kind],
  );
  const { entries, loading, error, done, sentinelRef } = useCursorPaged<MonthMediaEntry>(fetchPage);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (loading && entries.length === 0) {
    return <GridSkeleton />;
  }

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-scroll">
        <div className="weq-cache-avatar-grid">
          {entries.map((entry) => (
            <MonthCard key={`${entry.month}:${entry.hash}`} kind={kind} entry={entry} />
          ))}
        </div>
        <GridFooter
          loading={loading}
          done={done}
          count={entries.length}
          sentinelRef={sentinelRef}
        />
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
          <ShimmerImage src={previewSrc} alt={entry.hash} loading="lazy" />
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
    (cursor: string | null) =>
      client.account.mediaResource.listVoice.query({ cursor, limit: CURSOR_PAGE }),
    [],
  );
  const { entries, loading, error, done, sentinelRef } = useCursorPaged<VoiceMediaEntry>(fetchPage);

  // 转文字 only shows when a transcription model is selected in the settings.
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const canTranscribe = Boolean(settings.data?.voiceTranscribe.modelId);

  if (error && entries.length === 0) {
    return <div className="weq-cache-grid-state is-error">{error}</div>;
  }
  if (loading && entries.length === 0) {
    return <GridSkeleton />;
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
    nodes.push(<VoiceCard key={entry.rel} entry={entry} canTranscribe={canTranscribe} />);
  }

  return (
    <div className="weq-cache-avatar">
      <div className="weq-cache-avatar-scroll">
        <div className="weq-voice-grid">{nodes}</div>
        <GridFooter
          loading={loading}
          done={done}
          count={entries.length}
          sentinelRef={sentinelRef}
        />
      </div>
    </div>
  );
}

/**
 * One voice clip: a simulated waveform + duration + play/pause. The SILK bytes
 * are decoded to WAV on demand (first play), and the real duration replaces the
 * byte-estimated one once the audio's metadata loads. Playback progress lights
 * up the waveform left-to-right. With a transcription model configured, a
 * 转文字 button runs the recognizer over the clip and shows the text below.
 */
function VoiceCard({
  entry,
  canTranscribe,
}: {
  entry: VoiceMediaEntry;
  canTranscribe: boolean;
}): ReactElement {
  const bars = useMemo(() => fakeWaveform(entry.hash), [entry.hash]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [realDur, setRealDur] = useState<number | null>(null);
  const transcribe = trpc.account.mediaResource.transcribeVoice.useMutation();
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

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

  const runTranscribe = (): void => {
    if (transcribe.isLoading) return;
    setTranscribeError(null);
    transcribe
      .mutateAsync({ rel: entry.rel })
      .then((res) => {
        if (res.success) setTranscript(res.text ?? '');
        else setTranscribeError(res.error ?? '识别失败');
      })
      .catch((err) => setTranscribeError(err instanceof Error ? err.message : String(err)));
  };

  const seconds =
    realDur ?? Math.min(60, Math.max(1, Math.round(entry.bytes / SILK_BYTES_PER_SEC)));
  const filled = Math.round(progress * bars.length);
  const hasResult = transcript !== null || transcribeError !== null;

  return (
    <figure className="weq-voice-card" title={entry.name}>
      <button
        type="button"
        className={`weq-voice-player${playing ? ' is-playing' : ''}`}
        onClick={toggle}
      >
        <span className="weq-voice-btn" aria-hidden>
          {playing ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </span>
        <span className="weq-voice-wave" aria-hidden>
          {bars.map((h, i) => (
            <i
              // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
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
        {canTranscribe && !hasResult ? (
          <button
            type="button"
            className="weq-voice-t9n-btn"
            title="转文字"
            onClick={runTranscribe}
            disabled={transcribe.isLoading}
          >
            {transcribe.isLoading ? (
              <Loader2 size={11} strokeWidth={2} className="weq-spin" aria-hidden />
            ) : (
              <FileText size={11} strokeWidth={2} aria-hidden />
            )}
            <span>{transcribe.isLoading ? '转写中' : '转文字'}</span>
          </button>
        ) : null}
        <span className="weq-voice-size">{fmtBytes(entry.bytes)}</span>
      </figcaption>
      {hasResult ? (
        <div className={`weq-voice-t9n${transcribeError ? ' is-error' : ''}`}>
          {transcribeError ?? (transcript || '（未识别到语音内容）')}
        </div>
      ) : null}
    </figure>
  );
}
