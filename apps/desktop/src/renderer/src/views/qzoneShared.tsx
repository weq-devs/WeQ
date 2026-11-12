/**
 * 空间页与空友爱看共用的展示件。
 *
 * 这两套内容来自完全不同的协议（旧空间 web cgi 的 HTML 片段 vs. 爱看的 `cell_*`
 * 结构），但「页面容器 / 视口懒加载 / 媒体网格 / 预览 / 加载与错误态」是同一套交互，
 * 所以抽在这里共用，避免两份实现慢慢漂移。
 *
 * 样式仍走 `styles/qzone.css` 的 `weq-qzn-*` 类名。
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { CircleDot, Loader2, Pause, Play, VideoOff } from 'lucide-react';
import { QzoneMediaPreview, type QzonePreviewMedia } from '../components/QzoneMediaPreview';
import { albumMediaUrl } from '../lib/resourceUrl';
import { qzoneMediaSource } from '../lib/qzone';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { client } from '../trpc/client';
import { applyQzoneVideoTypes, type QzoneVideoType } from '../lib/qzoneMediaTypes';

/** 当前页是否可见 + 刷新代数（供子组件决定是否继续读）。 */
export const QzonePageContext = createContext({ active: true, refresh: 0 });
/** 上游明确不可用时暂停自动读取，保留已读内容。 */
export const QzoneReadPauseContext = createContext(false);

/** 元素是否进入（或接近）滚动容器视口；`once` 只触发一次。 */
export function useNearViewport(
  ref: RefObject<HTMLElement | null>,
  once = false,
  enabled = true,
): boolean {
  const [near, setNear] = useState(false);
  const { active } = useContext(QzonePageContext);
  useEffect(() => {
    if (!active || !enabled) {
      setNear(false);
      return undefined;
    }
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setNear(visible);
        if (visible && once) observer.disconnect();
      },
      { root: element.closest('.weq-qzn-scroll'), rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, once, active, enabled]);
  return active && enabled && near;
}

export function timeText(time: number): string {
  return time ? new Date(time * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
}

export function LoadingStatus({ text = '正在加载…' }: { text?: string }) {
  return (
    <p className="weq-qzn-loading" role="status">
      <Loader2 size={16} className="weq-spin" />
      {text}
    </p>
  );
}

export function State({
  loading,
  error,
  empty,
  retry,
  progress,
}: {
  loading: boolean;
  error: string;
  empty: string;
  retry?: () => void;
  progress?: string;
}) {
  return (
    <div className="weq-qzn-state" role="status">
      {loading ? (
        <>
          <Loader2 size={22} className="weq-spin" />
          正在加载…
        </>
      ) : error ? (
        <>
          <span>{error}</span>
          {retry ? (
            <button type="button" onClick={retry}>
              重试
            </button>
          ) : null}
        </>
      ) : (
        empty
      )}
      {progress ? <span className="weq-qzn-page-count">{progress}</span> : null}
    </div>
  );
}

export interface QzoneMediaVideo {
  coverUrl: string;
  videoUrl: string;
  videoId: string;
  duration: number;
  isLivePhoto?: boolean;
  mediaIndex?: number;
}

export function QzoneVideo({
  video,
  index,
  onOpen,
  typePending = false,
  active = true,
}: {
  video: QzoneMediaVideo;
  index: number;
  onOpen: () => void;
  typePending?: boolean;
  active?: boolean;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const src = qzoneMediaSource(video.videoUrl);
  const cover = qzoneMediaSource(video.coverUrl);
  const live = video.isLivePhoto === true;
  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);
  useEffect(() => {
    const element = player.current;
    if (!playing || !element) return;
    let current = true;
    void element.play().catch(() => {
      if (current) {
        setPlaying(false);
        setPlayError(true);
      }
    });
    return () => {
      current = false;
      element.pause();
    };
  }, [playing, src]);
  return (
    <div className="weq-qzn-video">
      <button
        type="button"
        className="weq-qzn-video-open"
        disabled={!src && !cover}
        aria-label={
          live
            ? `查看空间实况照片 ${index + 1}`
            : typePending
              ? `查看空间媒体 ${index + 1}`
              : src
                ? `播放空间视频 ${index + 1}`
                : `空间${video.isLivePhoto === true ? '实况照片' : '视频'} ${index + 1} 暂无播放地址`
        }
        title={
          typePending
            ? '查看媒体'
            : src
              ? video.isLivePhoto === true
                ? '查看实况照片'
                : '播放视频'
              : '此媒体暂时没有可播放地址'
        }
        onClick={onOpen}
      >
        {cover && !coverFailed ? (
          <img
            src={albumMediaUrl(cover)}
            alt={`${live ? '实况照片' : typePending ? '媒体封面' : '视频封面'} ${index + 1}`}
            loading="lazy"
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <span className="weq-qzn-video-placeholder">
            {coverFailed ? '封面暂时无法加载' : live ? '实况照片' : typePending ? '媒体' : '视频'}
          </span>
        )}
        {playing ? (
          <video
            ref={player}
            src={src ? albumMediaUrl(src) : undefined}
            muted
            playsInline
            onEnded={() => setPlaying(false)}
            onError={() => {
              setPlaying(false);
              setPlayError(true);
            }}
          />
        ) : null}
        {!live && !typePending ? (
          <span className="weq-qzn-video-play">
            {src ? <Play size={20} /> : <VideoOff size={20} />}
          </span>
        ) : null}
      </button>
      {live ? (
        <button
          type="button"
          className="weq-qzn-live-label"
          disabled={!src}
          aria-label={playing ? '暂停实况照片' : playError ? '重试播放实况照片' : '播放实况照片'}
          aria-pressed={playing}
          title={playing ? '暂停实况照片' : playError ? '播放失败，点击重试' : '播放实况照片'}
          onClick={() => {
            setPlayError(false);
            setPlaying((value) => !value);
          }}
        >
          {playing ? <Pause size={12} /> : <CircleDot size={12} />}
          实况
        </button>
      ) : null}
    </div>
  );
}

function Picture({ url, index, onOpen }: { url: string; index: number; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return failed ? (
    <span className="weq-qzn-image-unavailable">图片暂时无法加载</span>
  ) : (
    <button type="button" className="weq-qzn-picture" aria-busy={!loaded} onClick={onOpen}>
      {!loaded ? (
        <Loader2 size={22} className="weq-spin weq-qzn-picture-loader" aria-label="正在加载图片" />
      ) : null}
      <img
        src={albumMediaUrl(url)}
        alt={`空间图片 ${index + 1}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

/** 图片 / 视频网格 + 点击预览；两类来源同一套九宫格与键盘交互。 */
export function QzoneMediaGrid({
  images,
  videos = [],
  target,
}: {
  images: string[];
  videos?: QzoneMediaVideo[];
  target?: { selfUin: string; hostUin: string; tid: string; time: number };
}): ReactElement | null {
  const grid = useRef<HTMLDivElement>(null);
  const near = useNearViewport(
    grid,
    false,
    Boolean(target && target.time > 0 && videos.some((video) => video.videoId)),
  );
  const [preview, setPreview] = useState<number | null>(null);
  const { active, refresh } = useContext(QzonePageContext);
  const paused = useContext(QzoneReadPauseContext);
  const { run, cancel } = useQzoneRequests();
  const [types, setTypes] = useState<{ key: string; values: QzoneVideoType[] } | null>(null);
  const attempted = useRef('');
  const selfUin = target?.selfUin ?? '';
  const hostUin = target?.hostUin ?? '';
  const tid = target?.tid ?? '';
  const time = target?.time ?? 0;
  const ids = JSON.stringify(
    videos
      .map((video) => video.videoId)
      .filter(Boolean)
      .sort(),
  );
  const typeKey = JSON.stringify([selfUin, hostUin, tid, time, ids, refresh]);
  useEffect(() => {
    if (
      !active ||
      paused ||
      !near ||
      ids === '[]' ||
      !/^[1-9]\d{4,19}$/.test(selfUin) ||
      !/^[1-9]\d{4,19}$/.test(hostUin) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(tid) ||
      tid === '0' ||
      !Number.isSafeInteger(time) ||
      time <= 0 ||
      attempted.current === typeKey
    )
      return undefined;
    attempted.current = typeKey;
    let live = true;
    let settled = false;
    void run(
      (requestId) =>
        client.account.qzone.mediaTypes.query({ selfUin, hostUin, tid, time, requestId }),
      true,
    )
      .then((values) => {
        if (live) setTypes({ key: typeKey, values });
      })
      .catch(() => {
        if (live) setTypes({ key: typeKey, values: [] });
        /* 补全失败不阻塞或替换现有 Web 媒体。 */
      })
      .finally(() => {
        settled = true;
      });
    return () => {
      live = false;
      if (!settled) attempted.current = '';
      cancel();
    };
  }, [active, paused, near, selfUin, hostUin, tid, time, ids, typeKey, run, cancel]);
  const typedVideos = types?.key === typeKey ? applyQzoneVideoTypes(videos, types.values) : videos;
  useEffect(() => {
    setPreview(null);
  }, [refresh]);
  useEffect(() => {
    if (!active) {
      setPreview(null);
    }
  }, [active]);
  const seenVideos = new Set<string>();
  const uniqueVideos = typedVideos.filter((video) => {
    const key = video.videoId || video.videoUrl || video.coverUrl;
    if (!key || seenVideos.has(key)) return false;
    seenVideos.add(key);
    return true;
  });
  const covers = new Set(uniqueVideos.map((video) => qzoneMediaSource(video.coverUrl)));
  const urls = [
    ...new Set(
      images.map(qzoneMediaSource).filter((url): url is string => Boolean(url) && !covers.has(url)),
    ),
  ];
  const count = urls.length + uniqueVideos.length;
  const media: ({ kind: 'image'; url: string } | { kind: 'video'; video: QzoneMediaVideo })[] =
    urls.map((url) => ({ kind: 'image', url }));
  for (const video of [...uniqueVideos].sort(
    (a, b) => (a.mediaIndex ?? Infinity) - (b.mediaIndex ?? Infinity),
  )) {
    const index = video.mediaIndex;
    media.splice(
      index !== undefined && Number.isSafeInteger(index) && index >= 0
        ? Math.min(index, media.length)
        : media.length,
      0,
      { kind: 'video', video },
    );
  }
  const items: QzonePreviewMedia[] = media.map((entry) => {
    if (entry.kind === 'image')
      return { key: entry.url, kind: 'image', src: albumMediaUrl(entry.url) };
    const video = entry.video;
    const src = qzoneMediaSource(video.videoUrl);
    const poster = qzoneMediaSource(video.coverUrl);
    return {
      key: video.videoId || video.videoUrl,
      kind: src ? 'video' : 'image',
      src: src ? albumMediaUrl(src) : poster ? albumMediaUrl(poster) : '',
      poster: poster ? albumMediaUrl(poster) : undefined,
      isLivePhoto: video.isLivePhoto,
    };
  });
  return count ? (
    <>
      <div ref={grid} className="weq-qzn-pictures" data-media-count={count}>
        {media.map((entry, index) =>
          entry.kind === 'image' ? (
            <Picture
              key={entry.url}
              url={entry.url}
              index={index}
              onOpen={() => setPreview(index)}
            />
          ) : (
            <QzoneVideo
              key={entry.video.videoId || entry.video.videoUrl || entry.video.coverUrl}
              video={entry.video}
              index={index}
              typePending={Boolean(target && time > 0 && types?.key !== typeKey)}
              active={active && preview === null}
              onOpen={() => setPreview(index)}
            />
          ),
        )}
      </div>
      {preview !== null ? (
        <QzoneMediaPreview
          items={items}
          initialIndex={preview}
          onClose={() => {
            setPreview(null);
          }}
        />
      ) : null}
    </>
  ) : null;
}
