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
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { Loader2, Play, VideoOff } from 'lucide-react';
import { QzoneMediaPreview, type QzonePreviewMedia } from '../components/QzoneMediaPreview';
import { albumMediaUrl } from '../lib/resourceUrl';
import { qzoneMediaSource } from '../lib/qzone';

/** 当前页是否可见 + 刷新代数（供子组件决定是否继续读）。 */
export const QzonePageContext = createContext({ active: true, refresh: 0 });
/** 上游明确不可用时暂停自动读取，保留已读内容。 */
export const QzoneReadPauseContext = createContext(false);

/** 元素是否进入（或接近）滚动容器视口；`once` 只触发一次。 */
export function useNearViewport(ref: RefObject<HTMLElement | null>, once = false): boolean {
  const [near, setNear] = useState(false);
  const { active } = useContext(QzonePageContext);
  useEffect(() => {
    if (!active) {
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
  }, [ref, once, active]);
  return active && near;
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
}

export function QzoneVideo({
  video,
  index,
  onOpen,
}: {
  video: QzoneMediaVideo;
  index: number;
  onOpen: () => void;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const src = qzoneMediaSource(video.videoUrl);
  const cover = qzoneMediaSource(video.coverUrl);
  return (
    <button
      type="button"
      className="weq-qzn-video"
      disabled={!src}
      aria-label={src ? `播放空间视频 ${index + 1}` : `空间视频 ${index + 1} 暂无播放地址`}
      title={src ? '播放视频' : '此视频暂时没有可播放地址'}
      onClick={onOpen}
    >
      {cover && !coverFailed ? (
        <img
          src={albumMediaUrl(cover)}
          alt={`视频封面 ${index + 1}`}
          loading="lazy"
          onError={() => setCoverFailed(true)}
        />
      ) : (
        <span className="weq-qzn-video-placeholder">
          {coverFailed ? '视频封面暂时无法加载' : '视频'}
        </span>
      )}
      <span className="weq-qzn-video-play">
        {src ? <Play size={20} /> : <VideoOff size={20} />}
      </span>
    </button>
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
}: {
  images: string[];
  videos?: QzoneMediaVideo[];
}): ReactElement | null {
  const [preview, setPreview] = useState<number | null>(null);
  const { active, refresh } = useContext(QzonePageContext);
  useEffect(() => {
    setPreview(null);
  }, [refresh]);
  useEffect(() => {
    if (!active) {
      setPreview(null);
    }
  }, [active]);
  const seenVideos = new Set<string>();
  const uniqueVideos = videos.filter((video) => {
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
  const items: QzonePreviewMedia[] = [
    ...urls.map((url) => ({ key: url, kind: 'image' as const, src: albumMediaUrl(url) })),
    ...uniqueVideos.map((video) => ({
      key: video.videoId || video.videoUrl,
      kind: 'video' as const,
      src: albumMediaUrl(video.videoUrl),
      poster: video.coverUrl ? albumMediaUrl(video.coverUrl) : undefined,
    })),
  ];
  return count ? (
    <>
      <div className="weq-qzn-pictures" data-media-count={count}>
        {urls.map((url, index) => (
          <Picture key={url} url={url} index={index} onOpen={() => setPreview(index)} />
        ))}
        {uniqueVideos.map((video, index) => (
          <QzoneVideo
            key={video.videoId || video.videoUrl || video.coverUrl}
            video={video}
            index={index}
            onOpen={() => setPreview(urls.length + index)}
          />
        ))}
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
