/**
 * Renderers for QQ rich-media message elements: image, video, file, voice
 * (ptt) and market-face sticker. Bytes are streamed from the main process via
 * `weq-media://` (see src/main/media_protocol.ts); file-type icons come from
 * `weq-asset://fileIcon/…`. Images/videos/stickers render borderless (no
 * bubble); files render as a card; voice as a waveform + duration + play.
 */

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Cloud, FileText, Loader2 } from 'lucide-react';
import { fileIconUrl, mediaUrl } from '@renderer/lib/resourceUrl';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/trpc/client';
import { openLightbox } from './ImageLightbox';

type Data = Record<string, unknown>;

function str(d: Data, k: string): string {
  const v = d[k];
  return typeof v === 'string' ? v : '';
}
function num(d: Data, k: string): number {
  const v = d[k];
  return typeof v === 'number' ? v : Number(v) || 0;
}

/**
 * Scale (w×h) to fit within (maxW×maxH) preserving aspect ratio, never
 * upscaling. Returns null when the natural size is unknown, so the caller can
 * fall back to a max-bounded box.
 */
function fitWithin(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } | null {
  if (!w || !h) return null;
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/**
 * Gray placeholder shown when a media file can't be found on disk or via CDN.
 * Sized to the media's footprint (so the bubble doesn't jump) with a broken
 * image glyph and a "未找到该…" label.
 */
function QqMediaMissing({ label, style }: { label: string; style?: CSSProperties }) {
  return (
    <div className="qq-media-missing" style={style}>
      <svg className="qq-media-missing-icon" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M21 5v6.59l-3-3.01-4 4.01-4-4-4 4-3-3.01V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2m-3 6.42 3 3.01V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6.58l3 2.99 4-4 4 4z"
        />
      </svg>
      <span className="qq-media-missing-text">未找到{label}</span>
    </div>
  );
}

/** Reveal a video/file in the OS file manager via the main-process IPC. */
function revealMedia(t: number, name: string, type: 'video' | 'file'): void {
  const bridge = (window as { electron?: { ipcRenderer?: { invoke?: (c: string, a: unknown) => Promise<unknown> } } }).electron;
  void bridge?.ipcRenderer?.invoke?.('media:reveal', { t, name, type });
}

/** Reveal a file by msgId (searches file_assistant.db). Returns whether it was
 *  found locally so the caller can fall back to an OIDB download. */
async function revealFile(msgId: string): Promise<boolean> {
  const bridge = (window as any).electron;
  const result = (await bridge?.ipcRenderer?.invoke?.('file:reveal', msgId)) as {
    success: boolean;
    error?: string;
  };
  return Boolean(result?.success);
}

/** OIDB-download a file that isn't on disk, then reveal it. Needs online QQ. */
async function downloadFile(args: {
  msgId: string;
  name: string;
  token: string;
  conv: string;
}): Promise<{ success: boolean; error?: string }> {
  const bridge = (window as any).electron;
  const result = (await bridge?.ipcRenderer?.invoke?.('file:download', args)) as {
    success: boolean;
    error?: string;
  };
  return result ?? { success: false, error: '下载失败' };
}

/** Human-readable byte size. */
function formatSize(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

// ---- image --------------------------------------------------------------

export function QqImage({ data, sendTimeMs }: { data: Data; sendTimeMs: number }) {
  const [broken, setBroken] = useState(false);
  const name = str(data, 'fileName');
  const token = str(data, 'fileToken');
  const orig = str(data, 'originalUrl');
  const w = num(data, 'imgWidth');
  const h = num(data, 'imgHeight');
  // subType 1 = received animated emoji (served from Emoji/emoji-recv).
  const isAnimatedEmoji = num(data, 'subType') === 1;
  const maxW = isAnimatedEmoji ? 120 : 280;
  const maxH = isAnimatedEmoji ? 120 : 360;
  const fit = fitWithin(w, h, maxW, maxH);
  const style: CSSProperties = fit
    ? { width: fit.width, height: fit.height }
    : { maxWidth: maxW, maxHeight: maxH };

  if (broken) {
    return <QqMediaMissing label={isAnimatedEmoji ? '该表情' : '该图片'} style={style} />;
  }
  const params: Record<string, string | number> = { t: sendTimeMs, name, token };
  if (isAnimatedEmoji) params.recv = 1;
  if (orig) params.orig = orig;
  const src = mediaUrl('pic', params);
  // Animated emojis open nothing; real photos open the full-size lightbox.
  const openable = !isAnimatedEmoji;
  return (
    <img
      className={isAnimatedEmoji ? 'qq-media-mface' : 'qq-media-image'}
      style={openable ? { ...style, cursor: 'zoom-in' } : style}
      src={src}
      alt={isAnimatedEmoji ? '[动画表情]' : name || '[图片]'}
      draggable={false}
      onClick={openable ? () => openLightbox(src, name || '[图片]') : undefined}
      onError={() => setBroken(true)}
    />
  );
}

// ---- video --------------------------------------------------------------

export function QqVideo({
  data,
  sendTimeMs,
  msgId = '',
  conv = '',
}: {
  data: Data;
  sendTimeMs: number;
  msgId?: string;
  conv?: string;
}) {
  const [posterBroken, setPosterBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [videoBroken, setVideoBroken] = useState(false);
  const name = str(data, 'fileName');
  // Cover is fetched with videoToken; the original mp4 with fileToken.
  const coverToken = str(data, 'videoToken');
  const fileToken = str(data, 'fileToken');
  const w = num(data, 'videoWidth');
  const h = num(data, 'videoHeight');
  const duration = num(data, 'videoDuration');
  const fit = fitWithin(w, h, 280, 360);
  const style: CSSProperties = fit
    ? { width: fit.width, height: fit.height }
    : { maxWidth: 280, maxHeight: 360 };

  // Original couldn't be located locally or downloaded → missing placeholder.
  if (videoBroken) {
    return <QqMediaMissing label="该视频" style={style} />;
  }

  // Click → play inline. The media protocol locates the original on disk or
  // completes it via OIDB (msgId + conv let the host resolve the download URL);
  // a spinner covers the gap until the <video> can render its first frame.
  if (playing) {
    return (
      <div className="qq-media-video" style={style}>
        <video
          className="qq-media-video-player"
          src={mediaUrl('video', { t: sendTimeMs, name, token: fileToken, msgId, conv })}
          controls
          autoPlay
          onCanPlay={() => setLoading(false)}
          onError={() => {
            setVideoBroken(true);
            setPlaying(false);
          }}
        />
        {loading ? <span className="qq-media-spinner" aria-hidden /> : null}
      </div>
    );
  }

  return (
    <div
      className="qq-media-video"
      style={style}
      role="button"
      title="播放"
      onClick={() => {
        setLoading(true);
        setPlaying(true);
      }}
    >
      {posterBroken ? (
        <div className="qq-media-video-noposter" />
      ) : (
        <img
          className="qq-media-video-poster"
          src={mediaUrl('video', { t: sendTimeMs, name, v: 'thumb', token: coverToken })}
          alt={name || '[视频]'}
          draggable={false}
          onError={() => setPosterBroken(true)}
        />
      )}
      <span className="qq-media-video-play" aria-hidden />
      {duration > 0 ? <span className="qq-media-video-duration">{formatDuration(duration)}</span> : null}
    </div>
  );
}

// ---- file ---------------------------------------------------------------

const EXT_ICON: Record<string, string> = {
  ai: 'ai.png', apk: 'apk.png',
  mp3: 'audio.png', wav: 'audio.png', flac: 'audio.png', m4a: 'audio.png',
  bak: 'bak.png',
  ts: 'code.png', js: 'code.png', c: 'code.png', cpp: 'code.png', py: 'code.png', java: 'code.png',
  dmg: 'dmg.png', doc: 'doc.png', docx: 'doc.png', exe: 'exe.png',
  ttf: 'font.png', otf: 'font.png',
  jpg: 'image.png', jpeg: 'image.png', png: 'image.png', gif: 'image.png', webp: 'image.png',
  ipa: 'ipa.png', key: 'keynote.png', url: 'link.png', pdf: 'pdf.png', pkg: 'pkg.png',
  ppt: 'ppt.png', pptx: 'ppt.png', psd: 'ps.png', rar: 'rar.png',
  txt: 'txt.png', md: 'txt.png',
  mp4: 'video.png', mkv: 'video.png', avi: 'video.png', mov: 'video.png',
  xls: 'xls.png', xlsx: 'xls.png',
  zip: 'zip.png', '7z': 'zip.png', tar: 'zip.png', gz: 'zip.png',
};

function iconForName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return EXT_ICON[ext] ?? 'unknown.png';
}

export function QqFile({
  data,
  sendTimeMs,
  msgId,
  conv = '',
}: {
  data: Data;
  sendTimeMs: number;
  msgId: string;
  conv?: string;
}) {
  const name = str(data, 'fileName');
  const size = num(data, 'fileSize');
  const token = str(data, 'fileToken');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = (): void => {
    if (busy) return;
    setError(null);
    void (async () => {
      // 1. Local first: file_assistant.db → reveal in OS file manager.
      if (msgId && (await revealFile(msgId))) return;
      // 2. Not on disk → OIDB completion (needs an online QQ). Only msgId is
      //    required; token just disambiguates multiple files in one message.
      if (!msgId) {
        revealMedia(sendTimeMs, name, 'file');
        return;
      }
      setBusy(true);
      try {
        const r = await downloadFile({ msgId, name, token, conv });
        if (!r.success) setError(r.error ?? '下载失败');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div
      className="qq-media-file"
      role="button"
      title={error ?? (busy ? '正在下载…' : '在文件夹中打开（本地无则尝试下载）')}
      onClick={onClick}
    >
      <img className="qq-media-file-icon" src={fileIconUrl(iconForName(name))} alt="" draggable={false} />
      <div className="qq-media-file-meta">
        <div className="qq-media-file-name">{name || '[文件]'}</div>
        <div className={cn('qq-media-file-size', error && 'qq-media-file-error')}>
          {busy ? (
            <span className="qq-media-file-status">
              <Loader2 size={11} strokeWidth={2} className="weq-spin" aria-hidden /> 下载中…
            </span>
          ) : error ? (
            `下载失败：${error}`
          ) : (
            formatSize(size)
          )}
        </div>
      </div>
    </div>
  );
}

// ---- online file / folder ----------------------------------------------

/**
 * Online file & folder card (微云 / 离线传送). Same skeleton as `QqFile` (file
 * icon by extension + name + size) but with a cloud badge over the icon so the
 * eye distinguishes it from an on-disk file at a glance, and no reveal-in-
 * Explorer click (the bytes don't live locally). `kind === 'folder'` forces the
 * folder icon regardless of `fileName` extension.
 */
export function QqOnlineFile({ data, kind }: { data: Data; kind: 'file' | 'folder' }) {
  const name = str(data, 'fileName');
  const size = num(data, 'fileSize');
  const iconFile = kind === 'folder' ? 'folder.png' : iconForName(name);
  const placeholder = kind === 'folder' ? '[文件夹]' : '[文件]';
  return (
    <div className="qq-media-file qq-media-file-online" title={kind === 'folder' ? '在线文件夹' : '在线文件'}>
      <div className="qq-media-file-icon-wrap">
        <img className="qq-media-file-icon" src={fileIconUrl(iconFile)} alt="" draggable={false} />
        <Cloud className="qq-media-file-online-badge" size={14} strokeWidth={2.2} aria-hidden />
      </div>
      <div className="qq-media-file-meta">
        <div className="qq-media-file-name">{name || placeholder}</div>
        <div className="qq-media-file-size">{size > 0 ? formatSize(size) : kind === 'folder' ? '在线文件夹' : '在线文件'}</div>
      </div>
    </div>
  );
}

// ---- voice (ptt) --------------------------------------------------------

export function QqVoice({ data, sendTimeMs }: { data: Data; sendTimeMs: number }) {
  const name = str(data, 'fileName');
  const token = str(data, 'fileToken');
  const waveform = Array.isArray(data.waveform) ? (data.waveform as number[]) : [];
  // waveform is one byte per 0.1s; length/10 = duration in seconds.
  const seconds = waveform.length > 0 ? Math.max(1, Math.round(waveform.length / 10)) : 0;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Transcription state. The 转文字 entry only renders when a model is selected
  // in the global settings; one shared query (react-query de-dupes across the
  // many voice bubbles on screen) tells us whether that's the case.
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const canTranscribe = Boolean(settings.data?.voiceTranscribe.modelId);
  const transcribe = trpc.account.transcribeVoice.useMutation();
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  useEffect(() => {
    // Reset the player + transcript if the message identity changes underneath us.
    setPlaying(false);
    setTranscript(null);
    setTranscribeError(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [name, sendTimeMs]);

  const toggle = (): void => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(mediaUrl('ptt', { t: sendTimeMs, name, token }));
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  const runTranscribe = (e: ReactMouseEvent): void => {
    e.stopPropagation();
    if (transcribe.isLoading) return;
    setTranscribeError(null);
    transcribe
      .mutateAsync({ t: sendTimeMs, name, token })
      .then((res) => {
        if (res.success) setTranscript(res.text ?? '');
        else setTranscribeError(res.error ?? '识别失败');
      })
      .catch((err) => setTranscribeError(err instanceof Error ? err.message : String(err)));
  };

  // Downsample the envelope to a fixed bar count for a stable QQ-style strip.
  const bars = sampleBars(waveform, 28);
  const hasResult = transcript !== null || transcribeError !== null;

  return (
    <div className="qq-voice-wrap">
      <div className="qq-voice-row">
        <div className={cn('qq-media-voice', playing && 'is-playing')} role="button" onClick={toggle}>
          <span className="qq-media-voice-play" aria-hidden>
            {playing ? '❚❚' : '▶'}
          </span>
          <span className="qq-media-voice-wave" aria-hidden>
            {bars.map((v, i) => (
              <i key={i} style={{ height: `${20 + Math.round((v / 255) * 80)}%` }} />
            ))}
          </span>
          {seconds > 0 ? <span className="qq-media-voice-time">{seconds}″</span> : null}
        </div>
        {canTranscribe && !hasResult ? (
          <button
            type="button"
            className="qq-voice-transcribe-btn"
            title="转文字"
            onClick={runTranscribe}
            disabled={transcribe.isLoading}
          >
            {transcribe.isLoading ? (
              <Loader2 size={13} strokeWidth={2} className="weq-spin" aria-hidden />
            ) : (
              <FileText size={13} strokeWidth={2} aria-hidden />
            )}
            <span>{transcribe.isLoading ? '转写中' : '转文字'}</span>
          </button>
        ) : null}
      </div>

      {hasResult ? (
        <div className={cn('qq-voice-transcript', transcribeError && 'is-error')}>
          {transcribeError ?? (transcript ? transcript : '（未识别到内容）')}
        </div>
      ) : null}
    </div>
  );
}

// ---- market face --------------------------------------------------------

export function QqMarketFace({ data }: { data: Data }) {
  const [broken, setBroken] = useState(false);
  const pack = num(data, 'emojiPackId');
  const hash = str(data, 'previewMd5Hex');
  const w = num(data, 'previewWidth');
  const h = num(data, 'previewHeight');
  const size = 120;
  const style: CSSProperties =
    w && h ? { width: Math.min(w, size), aspectRatio: `${w} / ${h}` } : { width: size, height: size };

  if (broken || !pack || !hash) {
    return <QqMediaMissing label="该表情" style={style} />;
  }
  return (
    <img
      className="qq-media-mface"
      style={style}
      src={mediaUrl('mface', { pack, hash })}
      alt="[动画表情]"
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

// ---- helpers ------------------------------------------------------------

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Evenly downsample an envelope to `count` bars (averaging buckets). */
function sampleBars(waveform: number[], count: number): number[] {
  if (waveform.length === 0) return new Array(count).fill(40);
  if (waveform.length <= count) return waveform;
  const out: number[] = [];
  const step = waveform.length / count;
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += waveform[j] ?? 0;
    out.push(Math.round(sum / Math.max(1, end - start)));
  }
  return out;
}
