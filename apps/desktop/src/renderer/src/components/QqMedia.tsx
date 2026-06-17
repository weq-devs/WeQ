/**
 * Renderers for QQ rich-media message elements: image, video, file, voice
 * (ptt) and market-face sticker. Bytes are streamed from the main process via
 * `weq-media://` (see src/main/media_protocol.ts); file-type icons come from
 * `weq-asset://fileIcon/…`. Images/videos/stickers render borderless (no
 * bubble); files render as a card; voice as a waveform + duration + play.
 */

import { useEffect, useRef, useState } from 'react';
import { fileIconUrl, mediaUrl } from '@renderer/lib/resourceUrl';
import { cn } from '@renderer/lib/utils';

type Data = Record<string, unknown>;

function str(d: Data, k: string): string {
  const v = d[k];
  return typeof v === 'string' ? v : '';
}
function num(d: Data, k: string): number {
  const v = d[k];
  return typeof v === 'number' ? v : Number(v) || 0;
}

/** Reveal a video/file in the OS file manager via the main-process IPC. */
function revealMedia(t: number, name: string, type: 'video' | 'file'): void {
  const bridge = (window as { electron?: { ipcRenderer?: { invoke?: (c: string, a: unknown) => Promise<unknown> } } }).electron;
  void bridge?.ipcRenderer?.invoke?.('media:reveal', { t, name, type });
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
  const w = num(data, 'imgWidth');
  const h = num(data, 'imgHeight');
  // subType 1 = received animated emoji (served from Emoji/emoji-recv).
  const isAnimatedEmoji = num(data, 'subType') === 1;
  const maxW = isAnimatedEmoji ? 120 : 280;
  const style =
    w && h ? { width: Math.min(w, maxW), aspectRatio: `${w} / ${h}` } : { maxWidth: maxW };

  if (broken) {
    return <span className="qq-media-fallback">{isAnimatedEmoji ? '[动画表情]' : '[图片]'}</span>;
  }
  const src = mediaUrl('pic', isAnimatedEmoji ? { t: sendTimeMs, name, recv: 1 } : { t: sendTimeMs, name });
  return (
    <img
      className={isAnimatedEmoji ? 'qq-media-mface' : 'qq-media-image'}
      style={style}
      src={src}
      alt={isAnimatedEmoji ? '[动画表情]' : name || '[图片]'}
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

// ---- video --------------------------------------------------------------

export function QqVideo({ data, sendTimeMs }: { data: Data; sendTimeMs: number }) {
  const [broken, setBroken] = useState(false);
  const name = str(data, 'fileName');
  const w = num(data, 'videoWidth');
  const h = num(data, 'videoHeight');
  const duration = num(data, 'videoDuration');
  const maxW = 280;
  const style =
    w && h ? { width: Math.min(w, maxW), aspectRatio: `${w} / ${h}` } : { maxWidth: maxW };

  return (
    <div
      className="qq-media-video"
      style={style}
      role="button"
      title="在文件夹中打开"
      onClick={() => revealMedia(sendTimeMs, name, 'video')}
    >
      {broken ? (
        <div className="qq-media-video-noposter" />
      ) : (
        <img
          className="qq-media-video-poster"
          src={mediaUrl('video', { t: sendTimeMs, name, v: 'thumb' })}
          alt={name || '[视频]'}
          draggable={false}
          onError={() => setBroken(true)}
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

export function QqFile({ data, sendTimeMs }: { data: Data; sendTimeMs: number }) {
  const name = str(data, 'fileName');
  const size = num(data, 'fileSize');
  return (
    <div
      className="qq-media-file"
      role="button"
      title="在文件夹中打开"
      onClick={() => revealMedia(sendTimeMs, name, 'file')}
    >
      <img className="qq-media-file-icon" src={fileIconUrl(iconForName(name))} alt="" draggable={false} />
      <div className="qq-media-file-meta">
        <div className="qq-media-file-name">{name || '[文件]'}</div>
        <div className="qq-media-file-size">{formatSize(size)}</div>
      </div>
    </div>
  );
}

// ---- voice (ptt) --------------------------------------------------------

export function QqVoice({ data, sendTimeMs }: { data: Data; sendTimeMs: number }) {
  const name = str(data, 'fileName');
  const waveform = Array.isArray(data.waveform) ? (data.waveform as number[]) : [];
  // waveform is one byte per 0.1s; length/10 = duration in seconds.
  const seconds = waveform.length > 0 ? Math.max(1, Math.round(waveform.length / 10)) : 0;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    // Reset the player if the message identity changes underneath us.
    setPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [name, sendTimeMs]);

  const toggle = (): void => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(mediaUrl('ptt', { t: sendTimeMs, name }));
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

  // Downsample the envelope to a fixed bar count for a stable QQ-style strip.
  const bars = sampleBars(waveform, 28);

  return (
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
  const style =
    w && h ? { width: Math.min(w, size), aspectRatio: `${w} / ${h}` } : { width: size, height: size };

  if (broken || !pack || !hash) {
    return <span className="qq-media-fallback">[动画表情]</span>;
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
