import { useTaskMessageSource } from '../lib/notificationNavigation.shared';
import * as timeFormat from '@weq/time';
/**
 * Renderers for QQ rich-media message elements: image, video, file, voice
 * (ptt) and market-face sticker. Bytes are streamed from the main process via
 * `weq-media://` (see src/main/media_protocol.ts); file-type icons come from
 * `weq-asset://fileicon/…`. Images/videos/stickers render borderless (no
 * bubble); files render as a card; voice as a waveform + duration + play.
 */

import { formatBytes as formatSize } from '../lib/format';
import {
  useEffect,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Cloud,
  Download,
  Maximize,
  FileText,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Pause,
  Play,
  Sparkles,
  Star,
  Store,
  X,
  Zap,
} from 'lucide-react';
import { fileIconUrl, localFileUrl, localVoiceFileUrl, mediaUrl } from '@renderer/lib/resourceUrl';
import { useDataSaver } from '@renderer/lib/dataSaver';
import { cn } from '@renderer/lib/utils';
import { client, trpc } from '@renderer/trpc/client';
import { openMediaPreview } from './mediaPreviewStore.shared';

import {
  chatBlobImageSaveSource,
  chatFileSaveSource,
  chatImageLocalPath,
  chatImagePreviewSources,
  type ChatVideoAttachment,
  MediaBrowseContext,
  MediaItemKeyContext,
  useChatMediaOpen,
} from './ChatMediaGallery.shared';
import { useRenderDocument, resourceForRenderDocument } from '../lib/renderDocument';
import { openMarketFaceLightbox } from '../state/marketFaceLightbox';
import { ShimmerImage } from './ShimmerImage';
import { IS_ELECTRON } from '../lib/target.shared';
import {
  cdnImageUrl,
  cdnVideoCoverUrl,
  flashPicUrl,
  remoteChatThumbnailUrl,
  useCdn,
} from '@renderer/lib/cdn';
import { useMediaSave } from './MediaSaveControls.shared';
import type { MediaSaveSource } from '../../../shared/media_save';
import { useVoiceTranscription } from '../hooks/useVoiceTranscription';
import { WebAvatarScope } from '../hooks/useAvatarImage';
import { sharedAccountScope } from '../lib/remoteCacheBridge';
import { MessageTextResult } from './MessageTextResult';
import { MessageExpansion, MessageLayoutChange } from './MessageExpansion';
import { useTabActive } from './RetainedTabs.shared';
import { mediaRetryUrl } from '../lib/mediaRetryUrl';
import { useTransferProgress } from '../lib/transferActivity';
import {
  mediaTransferTarget,
  messageTransferTarget,
  transferPercent,
  type TransferProgress,
} from '../../../shared/transfer_progress';
import { MediaLoadingRing, MediaTransferBadge, TransferRing } from './TransferRing';
import { transferLabel } from '../lib/transferPresentation';
import { useVideoBuffering } from '../hooks/useVideoBuffering';
import { useMediaLoadAction } from '../hooks/useMediaLoadAction';
import { notifyMediaCached, watchMediaCache } from '../lib/mediaCacheArrival';
import { intrinsicMediaSize, messageMediaSize, type MediaSize } from '../lib/chatMediaSize';
import '../styles/media-preview.css';

type Data = Record<string, unknown>;

/** 原生媒体按键不交给消息列表的行导航；保留按钮和播放器的默认行为。 */
function mediaKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
  if (
    ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
      event.key,
    )
  )
    event.stopPropagation();
}

function str(d: Data, k: string): string {
  const v = d[k];
  return typeof v === 'string' ? v : '';
}
function num(d: Data, k: string): number {
  const v = d[k];
  return typeof v === 'number' ? v : Number(v) || 0;
}

/**
 * 闪照的固定封面：灰阶马赛克方块 + 白色闪电，所有闪照共用，不透露画面内容。
 *
 * 不再画 198 预览打模糊 —— 那是「真实画面打码」，只要缓存里有图，放大或改样式
 * 就能还原出内容；固定封面从数据上就没有可还原的东西。图片本体只在点开的灯箱里
 * 现取 0 档。
 */
function QqFlashCover({
  style,
  onClick,
}: {
  style?: CSSProperties;
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const Cover = onClick ? 'button' : 'span';
  return (
    <Cover
      type={onClick ? 'button' : undefined}
      className="qq-flash-cover qq-media-action"
      style={style}
      role={onClick ? undefined : 'img'}
      aria-label={onClick ? '查看闪照' : '闪照'}
      title="点击查看闪照"
      onClick={onClick}
      onKeyDown={onClick ? mediaKeyDown : undefined}
    >
      <Zap className="qq-flash-cover-bolt" fill="currentColor" strokeWidth={0} aria-hidden />
    </Cover>
  );
}

const decodedPreviewSizes = new Map<string, MediaSize>();

function useMediaPreviewSize(kind: 'pic' | 'video', data: Data, key: string) {
  const cacheKey = `${kind}:${key}`;
  const measure = () => ({
    key: cacheKey,
    size: messageMediaSize(kind, data, decodedPreviewSizes.get(cacheKey)),
  });
  const [preview, setPreview] = useState(measure);
  let current = preview;
  if (preview.key !== cacheKey) {
    current = measure();
    setPreview(current);
  }
  return {
    size: current.size,
    remember(width: number, height: number) {
      const size = decodedPreviewSizes.get(cacheKey) ?? intrinsicMediaSize(width, height);
      if (!size) return;
      // 当前气泡沿用首次布局，下次挂载才使用解码尺寸。
      decodedPreviewSizes.delete(cacheKey);
      decodedPreviewSizes.set(cacheKey, size);
      if (decodedPreviewSizes.size > 512)
        decodedPreviewSizes.delete(decodedPreviewSizes.keys().next().value!);
    },
  };
}

/** 尺寸保持原媒体占地；紧凑时用图形，详细操作保留在悬停与无障碍标签中。 */
function QqMediaMissing({
  label,
  style,
  onRetry,
  hint,
  state,
}: {
  label: string;
  style?: CSSProperties;
  onRetry?: () => void;
  hint?: string;
  state?: 'deferred' | 'failed';
}) {
  const Control = onRetry ? 'button' : 'span';
  const Icon = state === 'deferred' ? ImageIcon : ImageOff;
  const description =
    state === 'deferred'
      ? `${label}未自动加载`
      : state === 'failed'
        ? `${label}加载失败`
        : `未找到${label}`;
  return (
    <Control
      type={onRetry ? 'button' : undefined}
      className={cn('qq-media-missing', onRetry && 'qq-media-action')}
      style={style}
      role={onRetry || hint ? undefined : 'img'}
      aria-hidden={!onRetry && hint ? true : undefined}
      aria-label={onRetry ? hint?.replace(/^点击/, '') : hint ? undefined : description}
      title={hint ?? description}
      onClick={onRetry}
      onKeyDown={onRetry ? mediaKeyDown : undefined}
    >
      <Icon className="qq-media-missing-icon" strokeWidth={1.5} aria-hidden />
      {hint ? <span className="qq-media-missing-text">{hint}</span> : null}
    </Control>
  );
}

// ---- image --------------------------------------------------------------

export function QqImage({
  data,
  sendTimeMs,
  conv = '',
  msgId = '',
  fwd,
  interactive = true,
  gridTile = false,
  preferLocal = false,
}: {
  data: Data;
  sendTimeMs: number;
  conv?: string;
  msgId?: string;
  fwd?: ForwardRef;
  interactive?: boolean;
  gridTile?: boolean;
  preferLocal?: boolean;
}) {
  const messageSource = useTaskMessageSource();
  const limited = useDataSaver((state) => state.enabled);
  const behavior = useDataSaver((state) => state.behavior);
  const [requested, setRequested] = useState(false);
  const browse = useContext(MediaBrowseContext);
  const loadMedia = requested || browse;
  const galleryOpen = useChatMediaOpen();
  const previewKey = useContext(MediaItemKeyContext);
  const webScope = useContext(WebAvatarScope);
  const cacheScope = webScope && sharedAccountScope(webScope);
  const [unavailable, setUnavailable] = useState<'deferred' | 'failed'>();
  const [attempt, setAttempt] = useState(0);
  const [cacheRevision, setCacheRevision] = useState(0);
  const [loadedSource, setLoadedSource] = useState<string>();
  const ownerDocument = useRenderDocument();
  const name = str(data, 'fileName');
  const token = str(data, 'fileToken');
  const progressTarget = messageTransferTarget('pic', msgId, token, name, fwd);
  const orig = str(data, 'originalUrl');
  // 安卓 chatpic 兜底寻址用（见 main/media_protocol.ts 的 resolveChatpicFallback）。
  const md5 = str(data, 'md5');
  const w = num(data, 'imgWidth');
  const h = num(data, 'imgHeight');
  // subType 1 = received animated emoji (served from Emoji/emoji-recv).
  const isAnimatedEmoji = num(data, 'subType') === 1;

  // 定位规则升级后换 URL，避免继续命中此前空文件名误选图片的浏览器缓存。
  const params: Record<string, string | number> = { t: sendTimeMs, name, token, lookup: 2 };
  if (cacheScope && !isAnimatedEmoji) params.cacheScope = cacheScope;
  if (isAnimatedEmoji) params.recv = 1;
  if (orig) params.orig = orig;
  if (str(data, 'thumbnailUrl')) params.small = str(data, 'thumbnailUrl');
  if (md5) params.md5 = md5;
  const wantThumbnail =
    !isAnimatedEmoji && !(limited && behavior.dataSaverImageLoading === 'original');
  const cacheOnlyEmoji = isAnimatedEmoji && limited && !behavior.dataSaverEmoji && !loadMedia;
  const originalProxySrc = mediaUrl('pic', { ...params, intent: 'interactive' });
  const proxySrc = mediaUrl('pic', {
    ...params,
    ...(loadMedia ? { intent: 'interactive' } : {}),
    ...(wantThumbnail || (isAnimatedEmoji && limited && !behavior.dataSaverEmoji && !browse)
      ? { v: 'thumb' }
      : {}),
  });
  // 「优先使用 CDN」开着且拼得出直链时先试它（浏览器直连，服务端零流量）；rkey 过期 /
  // 老图片 / CDN 抽风都会 onError 落回上面这条代理路径，再失败才是「未找到」占位。
  const cdn = useCdn();
  // 发送中的 Blob 和 QQ 回读带回的本地路径都优先复用，文件仍由主进程校验后读取。
  const localPath = chatImageLocalPath(data);
  const localPreviewUrl = str(data, 'localPreviewUrl');
  const previewSize = useMediaPreviewSize(
    'pic',
    data,
    localPreviewUrl || localPath || originalProxySrc,
  );
  const style: CSSProperties = previewSize.size;
  // 闪照：`fileToken` 是老式 offpic 路径（`/uin-id-md5`），三档 URL 全空、没有
  // rkey 可用，但 offpic 本身免 rkey。气泡画固定封面，点开才现取 0 档原图。
  //
  // 判定闪照看两件事：元素带 `isFlash`（协议链路解出来的），或 token 形状是 offpic
  // 路径（本地库里落着的真实闪照只留兜底文案、没有 fileToken，补拉回来才带
  // `isFlash`）。自己刚发出去的那条有本地预览，照常显示预览，别换成封面。
  const flash =
    !localPreviewUrl && (Boolean((data as { isFlash?: unknown }).isFlash) || token.startsWith('/'));
  const flashFullSrc = flash ? flashPicUrl(token, 0) : null;
  const cdnSrc = flash || cdn.remote ? null : cdnImageUrl(cdn, conv !== '', token, orig);
  const directThumbnail =
    flash || isAnimatedEmoji || localPath || localPreviewUrl
      ? null
      : remoteChatThumbnailUrl(cdn, str(data, 'thumbnailUrl'), token, conv !== '');
  const candidates: string[] = [];
  if (localPreviewUrl) candidates.push(localPreviewUrl);
  const localSrc = localPath ? localFileUrl(localPath) : '';
  if (localSrc && localSrc !== localPreviewUrl) candidates.push(localSrc);
  if (preferLocal && !localPreviewUrl && !localSrc && (cdnSrc || directThumbnail))
    candidates.push(
      mediaUrl('pic', { ...params, localOnly: 1, ...(wantThumbnail ? { v: 'thumb' } : {}) }),
    );
  if (cdnSrc) candidates.push(cdnSrc);
  if (!candidates.includes(proxySrc)) candidates.push(proxySrc);
  if ((!limited || loadMedia) && !isAnimatedEmoji)
    candidates.push(loadMedia ? originalProxySrc : mediaUrl('pic', params));
  const [srcIndex, setSrcIndex] = useState(0);
  const source = candidates[Math.min(srcIndex, candidates.length - 1)] ?? proxySrc;
  const usingLocalPreview = source === localPreviewUrl;
  const src = mediaRetryUrl(source, attempt + cacheRevision);
  const ready = !unavailable && loadedSource === src;
  const retry = () => {
    setRequested(true);
    setSrcIndex(0);
    setAttempt((value) => value + 1);
    setUnavailable(undefined);
  };
  const tryNextImage = (state: 'deferred' | 'failed') => {
    if (state === 'deferred' || srcIndex >= candidates.length - 1) setUnavailable(state);
    else setSrcIndex((index) => index + 1);
  };

  useEffect(() => {
    setSrcIndex(0);
    setUnavailable(undefined);
  }, [localPath, localPreviewUrl, originalProxySrc, cdnSrc, limited, proxySrc]);
  useEffect(() => {
    if (ready || (!unavailable && !isAnimatedEmoji)) return;
    return watchMediaCache(ownerDocument, proxySrc, () => {
      setRequested(false);
      setAttempt(0);
      setSrcIndex(0);
      setUnavailable(undefined);
      setCacheRevision((value) => value + 1);
    });
  }, [isAnimatedEmoji, ownerDocument, proxySrc, ready, unavailable]);
  useEffect(() => {
    if (isAnimatedEmoji && ready && source === proxySrc) notifyMediaCached(ownerDocument, proxySrc);
  }, [isAnimatedEmoji, ownerDocument, proxySrc, ready, source]);

  const openable = interactive;
  /** 服务端副本的到期时刻（ms），元素没带 TTL 时为 undefined。 */
  const ttlSeconds = num(data, 'fileTTL');
  const uploadedSeconds = num(data, 'uploadTimestamp');
  const expiresAtMs =
    ttlSeconds > 0 && uploadedSeconds > 0 ? (uploadedSeconds + ttlSeconds) * 1000 : undefined;
  // 灯箱的 OCR 上下文：真图片（拿得到 fileToken + 尺寸）才给 —— 灯箱据此才会出现 OCR
  // 按钮。会话场景按 ConvContext 的约定判断（群号非空 = 群聊，空 = 私聊），和视频 /
  // 文件那几条 OIDB 链路同一口径。
  const ocrContext =
    openable && !isAnimatedEmoji && token && w && h
      ? {
          peerType: conv ? ('group' as const) : ('c2c' as const),
          fileToken: token,
          width: w,
          height: h,
          md5: /^[0-9a-f]{32}$/i.test(md5) ? md5.toLowerCase() : undefined,
          fileSize: num(data, 'fileSize') || undefined,
          // 服务端副本的到期时刻：元素里 uploadTimestamp(45517) + fileTTL(45518) 正好等于
          // 45505，实测 TTL 是 777600 秒（9 天）。过期后 OCR 必然失败（URL 是交给服务端去
          // 取的，本地有缓存也没用），所以前端提前拦一下。
          expiresAt: expiresAtMs,
        }
      : null;
  // 闪照气泡：固定封面，不加载任何图片。尺寸跟着元素里的宽高走（拿不到就给一个
  // 竖向短图的默认框），点击才现取 0 档原图 —— 拿不到 URL 时连点都点不开。
  if (flash) {
    return (
      <span className="qq-media-image-preview-wrap">
        <QqFlashCover
          style={{ ...style, cursor: flashFullSrc && interactive ? 'zoom-in' : undefined }}
          onClick={
            flashFullSrc && interactive
              ? (event) => {
                  openMediaPreview({
                    items: [
                      {
                        key: flashFullSrc,
                        kind: 'image',
                        src: flashFullSrc,
                        title: name || '[闪照]',
                        ocr: ocrContext,
                        progressTarget,
                        messageSource,
                      },
                    ],
                    ownerDocument: event.currentTarget.ownerDocument,
                  });
                }
              : undefined
          }
        />
        <MediaTransferBadge target={progressTarget} />
      </span>
    );
  }
  const ImageControl = openable ? 'button' : 'span';
  const previewSrc = source === proxySrc ? originalProxySrc : source;
  const kindLabel = isAnimatedEmoji ? '表情' : '图片';
  const loading = attempt > 0 && !ready && !unavailable;
  const description =
    unavailable === 'deferred' ? `${kindLabel}未自动加载` : `${kindLabel}加载失败`;
  const actionLabel = ready
    ? `查看${kindLabel}${name ? `：${name}` : ''}`
    : loading
      ? `正在加载${kindLabel}`
      : unavailable === 'failed'
        ? `重试加载${kindLabel}`
        : `加载${kindLabel}`;
  return (
    <span className="qq-media-image-preview-wrap">
      {/* 缩略图换源或失败时保留同一个点击目标，避免按下后按钮被卸载。 */}
      <ImageControl
        type={openable ? 'button' : undefined}
        onKeyDown={openable ? mediaKeyDown : undefined}
        aria-label={openable ? actionLabel : undefined}
        aria-description={openable && unavailable ? description : undefined}
        aria-busy={loading || undefined}
        title={
          openable ? (unavailable ? `${description}，${actionLabel}` : actionLabel) : undefined
        }
        data-load-action={openable && !ready ? true : undefined}
        className={cn('qq-media-wrap qq-media-action', isAnimatedEmoji && 'qq-media-wrap-emoji')}
        data-favorite-emoji-source={originalProxySrc}
        onClick={
          openable
            ? (event) => {
                if (!ready) {
                  if (!loading) retry();
                  return;
                }
                const preview = isAnimatedEmoji ? undefined : chatImagePreviewSources(data, params);
                const displayedFallback = localSrc && source !== localSrc ? [src] : [];
                if (
                  galleryOpen?.(previewKey, event.currentTarget.ownerDocument, {
                    src: preview?.src ?? previewSrc,
                    originalImage: preview?.originalImage,
                    ocr: ocrContext,
                    fallbackSources: preview ? displayedFallback : [originalProxySrc, proxySrc],
                    progressTarget,
                  })
                )
                  return;
                openMediaPreview({
                  items: [
                    {
                      key: previewSrc,
                      kind: 'image',
                      src: preview?.src ?? previewSrc,
                      originalImage: preview?.originalImage,
                      saveSource: chatBlobImageSaveSource(previewSrc, params),
                      title: name || (isAnimatedEmoji ? '[表情]' : '[图片]'),
                      ocr: ocrContext,
                      progressTarget,
                      messageSource,
                      fallbackSources: preview
                        ? displayedFallback
                        : [
                            ...candidates
                              .slice(srcIndex + 1)
                              .map((candidate) =>
                                candidate === proxySrc ? originalProxySrc : candidate,
                              ),
                            proxySrc,
                          ],
                    },
                  ],
                  ownerDocument: event.currentTarget.ownerDocument,
                });
              }
            : undefined
        }
      >
        {unavailable ? (
          <QqMediaMissing
            label={kindLabel}
            state={unavailable}
            hint={
              openable
                ? unavailable === 'deferred'
                  ? '点击加载'
                  : '加载失败，点击重试'
                : undefined
            }
            style={gridTile ? undefined : { ...style, minWidth: 0, minHeight: 0, padding: 0 }}
          />
        ) : (
          <ShimmerImage
            suspendOffscreen
            remoteImageSrc={source === proxySrc ? directThumbnail : null}
            abortableThumbnail={source === proxySrc && (wantThumbnail || cacheOnlyEmoji)}
            onThumbnailError={tryNextImage}
            reuseRemoteCache
            mediaLoading={loading || (!isAnimatedEmoji && !usingLocalPreview)}
            className={isAnimatedEmoji ? 'qq-media-mface' : 'qq-media-image'}
            style={gridTile ? undefined : w && h ? style : { ...style, objectFit: 'contain' }}
            width={previewSize.size.width}
            height={previewSize.size.height}
            src={src}
            alt={isAnimatedEmoji ? '[动画表情]' : name || '[图片]'}
            draggable={false}
            loading={usingLocalPreview || loading ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={(event) => {
              setLoadedSource(src);
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (!w || !h) previewSize.remember(naturalWidth, naturalHeight);
            }}
            onError={() => tryNextImage('failed')}
          />
        )}
      </ImageControl>
      <MediaTransferBadge target={isAnimatedEmoji ? undefined : progressTarget} />
    </span>
  );
}

// ---- video --------------------------------------------------------------

/** Identifies a 合并转发 sub-message: which record inside the carrier's 40900
 *  cache the medium belongs to. Absent for normal timeline messages. */
export interface ForwardRef {
  fwdMsgId: string;
  fwdKind: import('@weq/db').ForwardCacheKind;
  fwdResId?: string;
}

export function QqVideo({
  data,
  sendTimeMs,
  msgId = '',
  conv = '',
  fwd,
  bubble = false,
  templateName = '',
  interactive = true,
  attachment,
}: {
  data: Data;
  sendTimeMs: number;
  msgId?: string;
  conv?: string;
  fwd?: ForwardRef;
  bubble?: boolean;
  templateName?: string;
  interactive?: boolean;
  attachment?: ChatVideoAttachment;
}) {
  const messageSource = useTaskMessageSource();
  useDataSaver((state) => state.behavior.dataSaverVideoCovers);
  const browse = useContext(MediaBrowseContext);
  const galleryOpen = useChatMediaOpen();
  const previewKey = useContext(MediaItemKeyContext);
  const [posterBroken, setPosterBroken] = useState(false);
  const [readyCover, setReadyCover] = useState<string>();
  const [readyVideo, setReadyVideo] = useState<string>();
  const ownerDocument = useRenderDocument();
  const [playing, setPlaying] = useState(bubble);
  const tabActive = useTabActive();
  const [videoBroken, setVideoBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const playerRef = useRef<HTMLVideoElement>(null);
  const focusPlayer = useRef(false);
  useEffect(() => {
    if (playing && !videoBroken && focusPlayer.current) {
      playerRef.current?.focus({ preventScroll: true });
      focusPlayer.current = false;
    }
  }, [playing, videoBroken, attempt]);
  const name = str(data, 'fileName');
  // Cover is fetched with videoToken; the original mp4 with fileToken.
  const coverToken = str(data, 'videoToken');
  const fileToken = str(data, 'fileToken');
  const progressTarget =
    attachment?.progressTarget ?? messageTransferTarget('video', msgId, fileToken, name, fwd);
  const w = num(data, 'videoWidth');
  const h = num(data, 'videoHeight');
  const duration = num(data, 'videoDuration');

  // 封面同图片：CDN 直链优先，失败落回代理。原片不参与——那要 OIDB 现签 URL。
  const cdn = useCdn();
  const [coverCdnFailed, setCoverCdnFailed] = useState(false);
  const coverCdn = cdn.remote ? null : cdnVideoCoverUrl(cdn, conv !== '', coverToken);
  const proxyCover = mediaUrl('video', {
    t: sendTimeMs,
    name,
    v: 'thumb',
    token: coverToken,
    ...(browse ? { intent: 'interactive' } : {}),
  });
  // 合并转发编辑器里拼的视频带 `localPath` / `thumbLocalPath`（本机绝对路径）——
  // 还没上传、不在 Video 缓存里，按发送时间 / 文件名去找会 404，直接从本机文件流
  // （主进程只放行 nt_data 内 + 用户亲手选中的路径）。乐观渲染的视频带
  // `localPreviewUrl`（blob:）。真实消息不带这几个字段，主时间线行为不变。
  const localPath = str(data, 'localPath');
  const thumbLocalPath = str(data, 'thumbLocalPath');
  const localPreviewUrl = str(data, 'localPreviewUrl');
  const localCoverSrc = thumbLocalPath ? localFileUrl(thumbLocalPath) : localPreviewUrl;
  const previewSize = useMediaPreviewSize(
    'video',
    data,
    attachment?.src ?? (localCoverSrc || localPath || proxyCover),
  );
  // 视频气泡填满已有的 120×120 圆形容器。
  const style: CSSProperties = bubble ? { width: '100%', height: '100%' } : previewSize.size;
  const coverSrc = attachment
    ? undefined
    : localCoverSrc || (!coverCdnFailed && coverCdn) || proxyCover;
  useEffect(() => setPosterBroken(false), [coverSrc]);

  // Original couldn't be located locally or downloaded → missing placeholder.
  // bubble mode: show templateName as label so the user knows what it was.
  const missingVideo = videoBroken ? (
    <QqMediaMissing
      label={bubble && templateName ? templateName : '该视频'}
      style={{ ...style, minWidth: 0, minHeight: 0, padding: 0 }}
      hint={interactive ? '点击重试加载视频' : undefined}
      onRetry={
        interactive
          ? () => {
              focusPlayer.current = true;
              setAttempt((value) => value + 1);
              setVideoBroken(false);
              setPlaying(true);
            }
          : undefined
      }
    />
  ) : null;

  const videoSrc = mediaRetryUrl(
    resourceForRenderDocument(
      attachment?.src ??
        (localPath
          ? localFileUrl(localPath)
          : localPreviewUrl ||
            mediaUrl('video', {
              t: sendTimeMs,
              name,
              token: fileToken,
              msgId,
              conv,
              ...(fwd ? { fwdMsgId: fwd.fwdMsgId, fwdKind: fwd.fwdKind } : {}),
              ...(fwd?.fwdResId ? { fwdResId: fwd.fwdResId } : {}),
            })),
      ownerDocument,
    ),
    attempt,
  );
  const buffering = useVideoBuffering(videoSrc, tabActive && bubble && playing);

  // bubble mode: auto-play muted loop, no controls, fill the circle container.
  if (bubble) {
    if (missingVideo) return missingVideo;
    return (
      <div className="qq-media-video" style={style} onKeyDown={mediaKeyDown}>
        <video
          key={videoSrc}
          ref={playerRef}
          className="qq-media-video-player"
          src={videoSrc}
          muted
          loop
          autoPlay
          playsInline
          {...buffering.events}
          onError={() => {
            buffering.events.onError();
            setVideoBroken(true);
          }}
        />
        {buffering.waiting && <MediaLoadingRing label="正在缓冲视频" />}
        <MediaTransferBadge target={progressTarget} />
      </div>
    );
  }

  function expand() {
    playerRef.current?.pause();
    if (!galleryOpen?.(previewKey, ownerDocument, { progressTarget }))
      openMediaPreview({
        items: [
          {
            key: videoSrc,
            kind: 'video',
            src: videoSrc,
            poster: coverSrc,
            title: name,
            progressTarget,
            messageSource,
            saveSource: attachment?.saveSource,
          },
        ],
        ownerDocument: ownerDocument,
      });
  }
  const expandButton =
    interactive &&
    !videoBroken &&
    (readyVideo === videoSrc || (!posterBroken && coverSrc && readyCover === coverSrc)) ? (
      <button
        type="button"
        className="weq-video-expand"
        aria-label="放大预览视频"
        title="放大预览视频"
        onClick={expand}
      >
        <Maximize size={17} />
      </button>
    ) : null;

  if (missingVideo) {
    return (
      <div className="weq-video-preview-wrap">
        {missingVideo}
        <MediaTransferBadge target={progressTarget} />
      </div>
    );
  }

  // 普通原位播放由原生控件显示缓冲提示；无控件的圆形视频使用上方的缓冲圈。
  if (playing) {
    return (
      <div className="weq-video-preview-wrap">
        <div className="qq-media-video" style={style} onKeyDown={mediaKeyDown}>
          <video
            key={videoSrc}
            ref={playerRef}
            tabIndex={0}
            className="qq-media-video-player"
            src={videoSrc}
            controls
            autoPlay
            onCanPlay={() => setReadyVideo(videoSrc)}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (!w || !h) previewSize.remember(videoWidth, videoHeight);
            }}
            onError={() => {
              setVideoBroken(true);
              setPlaying(false);
            }}
          />
        </div>
        <MediaTransferBadge target={progressTarget} />
        {expandButton}
      </div>
    );
  }

  const VideoControl = interactive ? 'button' : 'div';
  return (
    <div className="weq-video-preview-wrap">
      <VideoControl
        type={interactive ? 'button' : undefined}
        className="qq-media-video qq-media-action"
        style={style}
        aria-label={interactive ? (name ? `播放视频：${name}` : '播放视频') : undefined}
        onKeyDown={interactive ? mediaKeyDown : undefined}
        title={interactive ? '播放' : '视频'}
        onClick={
          interactive
            ? () => {
                focusPlayer.current = true;
                setPlaying(true);
              }
            : undefined
        }
      >
        {posterBroken || !coverSrc ? (
          <div className="qq-media-video-noposter" />
        ) : (
          <ShimmerImage
            suspendOffscreen
            reuseRemoteCache
            mediaLoading
            className="qq-media-video-poster"
            src={coverSrc}
            style={!w || !h ? { objectFit: 'contain' } : undefined}
            alt={name || '[视频]'}
            draggable={false}
            onLoad={(event) => {
              setReadyCover(coverSrc);
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (!w || !h) previewSize.remember(naturalWidth, naturalHeight);
            }}
            onError={() => {
              if (coverSrc === coverCdn) setCoverCdnFailed(true);
              else setPosterBroken(true);
            }}
          />
        )}
        <span className="qq-media-video-play" aria-hidden />
        {duration > 0 ? (
          <span className="qq-media-video-duration">
            <span className="weq-number weq-number-inherit">{formatDuration(duration)}</span>
          </span>
        ) : null}
      </VideoControl>
      <MediaTransferBadge target={progressTarget} />
      {expandButton}
    </div>
  );
}

// ---- file ---------------------------------------------------------------

const EXT_ICON: Record<string, string> = {
  ai: 'ai.png',
  apk: 'apk.png',
  mp3: 'audio.png',
  wav: 'audio.png',
  flac: 'audio.png',
  m4a: 'audio.png',
  bak: 'bak.png',
  ts: 'code.png',
  js: 'code.png',
  c: 'code.png',
  cpp: 'code.png',
  py: 'code.png',
  java: 'code.png',
  dmg: 'dmg.png',
  doc: 'doc.png',
  docx: 'doc.png',
  exe: 'exe.png',
  ttf: 'font.png',
  otf: 'font.png',
  jpg: 'image.png',
  jpeg: 'image.png',
  png: 'image.png',
  gif: 'image.png',
  webp: 'image.png',
  ipa: 'ipa.png',
  key: 'keynote.png',
  url: 'link.png',
  pdf: 'pdf.png',
  pkg: 'pkg.png',
  ppt: 'ppt.png',
  pptx: 'ppt.png',
  psd: 'ps.png',
  rar: 'rar.png',
  txt: 'txt.png',
  md: 'markdown.png',
  mp4: 'video.png',
  mkv: 'video.png',
  avi: 'video.png',
  mov: 'video.png',
  xls: 'xls.png',
  xlsx: 'xls.png',
  zip: 'zip.png',
  '7z': 'zip.png',
  tar: 'zip.png',
  gz: 'zip.png',
};

function iconForName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return EXT_ICON[ext] ?? 'unknown.png';
}

function FileDownloadRing({
  progress,
  onCancel,
}: {
  progress: TransferProgress;
  onCancel?: () => void;
}) {
  return (
    <span className="qq-file-download-ring">
      <TransferRing progress={progress} label="文件下载进度" size={24} />
      {onCancel ? (
        <button
          className="qq-file-download-cancel"
          type="button"
          title="停止本次下载"
          aria-label="停止本次下载"
          onKeyDown={mediaKeyDown}
          onClick={(event) => {
            event.stopPropagation();
            onCancel();
          }}
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

export function QqFile({
  data,
  sendTimeMs,
  msgId,
  conv = '',
  fwd,
}: {
  data: Data;
  sendTimeMs: number;
  msgId: string;
  conv?: string;
  fwd?: ForwardRef;
}) {
  const active = useTabActive();
  const name = str(data, 'fileName'),
    size = num(data, 'fileSize'),
    token = str(data, 'fileToken');
  const previewPath = !msgId && !fwd?.fwdResId ? str(data, 'localPath') : '';
  const mediaSave = useMediaSave({ foreground: true, ownerKey: `${active}:${conv}:${msgId}` });
  const chatFile = chatFileSaveSource({
    msgId,
    name,
    token,
    conv,
    ...fwd,
  });
  const source: MediaSaveSource = previewPath
    ? { kind: 'url', url: localFileUrl(previewPath), name }
    : chatFile;
  const canOpenHere = IS_ELECTRON;
  const hasMessage = /^\d+$/.test(msgId) || Boolean(fwd?.fwdResId);
  const hasDownloadAction = hasMessage || (!canOpenHere && Boolean(previewPath));
  const lookup = {
    ...mediaSave.binding,
    target: {
      kind: 'file' as const,
      t: sendTimeMs,
      name,
      token,
      md5: '',
      msgId: source.kind === 'chat-file' ? source.msgId : msgId,
      conv,
      ...(source.kind === 'chat-file'
        ? { fwdMsgId: source.fwdMsgId, fwdKind: source.fwdKind, fwdResId: source.fwdResId }
        : {}),
      pack: '',
      hash: '',
      label: name,
    },
  };
  const checkLocal = canOpenHere && hasMessage;
  const locations = trpc.account.mediaResource.messageLocations.useQuery(
    { ...lookup, exactFile: true },
    {
      enabled: checkLocal && active && Boolean(mediaSave.binding),
      staleTime: 0,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      retry: false,
    },
  );
  const local =
    locations.data?.find((location) => location.kind === 'local' && location.available) ??
    locations.data?.find((location) => location.available);
  const opensFile = canOpenHere && Boolean(previewPath || local);
  const transfer = useTransferProgress(active ? mediaTransferTarget(source) : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ action: 'open' | 'save'; message: string } | null>(null);
  const saveRecord = mediaSave.recordFor(source);
  const paused = !busy && saveRecord?.status === 'paused';
  const progress = paused
    ? undefined
    : (transfer ?? (busy && !opensFile ? { phase: 'preparing' as const } : undefined));
  const downloading = Boolean(progress);
  const percent = progress ? transferPercent(progress) : undefined;
  const transferring = Boolean(transfer);
  const wasTransferring = useRef(false);
  const refetchLocations = locations.refetch;
  useEffect(() => {
    if (wasTransferring.current && !transferring && !busy && checkLocal && active)
      void refetchLocations();
    wasTransferring.current = transferring;
  }, [transferring, busy, checkLocal, active, refetchLocations]);
  const working = busy || (downloading && !opensFile);
  const showSave = !opensFile && hasMessage && (!checkLocal || locations.isFetched);
  const errorText = error
    ? `${error.action === 'open' ? '打开' : '保存'}失败：${error.message}`
    : str(data, 'transferErrorText').trim();
  const showError = !downloading && !working && !paused && Boolean(errorText);
  const onClick = (saveOnly = false): void => {
    if (working) return;
    setError(null);
    setBusy(true);
    void (async () => {
      let action: 'open' | 'save' = canOpenHere && !saveOnly ? 'open' : 'save';
      try {
        if (action === 'open' && previewPath) {
          const result = await client.account.fileResource.download.open.mutate({
            path: previewPath,
          });
          if (!result.ok) throw new Error(result.error);
          return;
        }
        if (action === 'open' && checkLocal) {
          if (!mediaSave.binding) throw new Error('账号资料尚未就绪，请重试');
          if (
            await client.account.mediaResource.openMessageFile.mutate({
              ...lookup,
              location: local,
            })
          )
            return;
        }
        if (!hasMessage && !previewPath) throw new Error('文件定位信息不足');
        action = 'save';
        const result = await mediaSave.run(source, paused ? saveRecord.taskId : undefined);
        if (result.error) setError({ action, message: result.error });
        else if (result.taskId && !result.cancelled && checkLocal) await refetchLocations();
      } catch (e) {
        setError({ action, message: e instanceof Error ? e.message : String(e) });
        if (checkLocal && action === 'open') void locations.refetch();
      } finally {
        setBusy(false);
      }
    })();
  };
  const busyLabel = progress
    ? `${transferLabel(progress)}…`
    : opensFile
      ? '正在打开…'
      : '准备保存…';
  const fileRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={fileRef}
      className={cn('qq-media-file', hasDownloadAction && 'qq-media-file-downloadable')}
    >
      <MessageLayoutChange
        anchor={fileRef}
        details={[['.qq-media-file-size', working, downloading, showError, errorText]]}
      />
      <button
        type="button"
        className="qq-media-file-open"
        onClick={() => onClick()}
        disabled={working}
        onKeyDown={mediaKeyDown}
        title={error?.message ?? (working ? busyLabel : opensFile ? '打开文件（本机）' : '另存为')}
      >
        <img
          className="qq-media-file-icon"
          src={fileIconUrl(iconForName(name))}
          alt=""
          draggable={false}
        />
        <span className="qq-media-file-meta">
          <span className="qq-media-file-name" title={name}>
            {name || '[文件]'}
          </span>
          <span
            className={cn('qq-media-file-size', showError && 'qq-media-file-error')}
            title={showError ? errorText : undefined}
          >
            {downloading ? (
              <span className="qq-media-file-status">
                {percent === undefined ? busyLabel : <span className="weq-number">{percent}%</span>}
              </span>
            ) : working ? (
              <span className="qq-media-file-status">
                <Loader2 size={11} strokeWidth={2} className="weq-spin" aria-hidden /> {busyLabel}
              </span>
            ) : paused ? (
              '下载已暂停'
            ) : showError ? (
              errorText
            ) : (
              <span className="weq-number">{formatSize(size)}</span>
            )}
          </span>
        </span>
      </button>
      {hasDownloadAction ? (
        <div
          className="qq-file-action"
          data-paused={paused || undefined}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {progress ? (
            <FileDownloadRing
              progress={progress}
              onCancel={mediaSave.isBusy(source) ? () => void mediaSave.cancel(source) : undefined}
            />
          ) : paused ? (
            <>
              <button
                type="button"
                className="icon-button"
                title="继续下载"
                aria-label="继续下载"
                onClick={() => onClick(true)}
                onKeyDown={mediaKeyDown}
              >
                <Play size={15} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                title="停止本次下载"
                aria-label="停止本次下载"
                onClick={() => void mediaSave.cancel(source)}
                onKeyDown={mediaKeyDown}
              >
                <X size={15} aria-hidden />
              </button>
            </>
          ) : showSave ? (
            <button
              type="button"
              className="icon-button"
              title="另存为"
              aria-label="保存文件"
              disabled={working || mediaSave.disabled}
              onClick={() => onClick(true)}
              onKeyDown={mediaKeyDown}
            >
              <Download size={15} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
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
    <div
      className="qq-media-file qq-media-file-online"
      title={kind === 'folder' ? '在线文件夹' : '在线文件'}
    >
      <div className="qq-media-file-icon-wrap">
        <img className="qq-media-file-icon" src={fileIconUrl(iconFile)} alt="" draggable={false} />
        <Cloud className="qq-media-file-online-badge" size={14} strokeWidth={2.2} aria-hidden />
      </div>
      <div className="qq-media-file-meta">
        <div className="qq-media-file-name">{name || placeholder}</div>
        <div className="qq-media-file-size">
          {size > 0 ? (
            <span className="weq-number">{formatSize(size)}</span>
          ) : kind === 'folder' ? (
            '在线文件夹'
          ) : (
            '在线文件'
          )}
        </div>
      </div>
    </div>
  );
}

// ---- voice (ptt) --------------------------------------------------------

export function QqVoice({
  data,
  sendTimeMs,
  msgId = '',
  mediaMsgId = '',
  conv = '',
  fwd,
}: {
  data: Data;
  sendTimeMs: number;
  msgId?: string;
  mediaMsgId?: string;
  conv?: string;
  fwd?: ForwardRef;
}) {
  const name = str(data, 'fileName');
  const token = str(data, 'fileToken');
  const mediaKey = useContext(MediaItemKeyContext);
  const livePending = data.livePending === true;
  // 合并转发编辑器里刚选的语音带 `localPath`（SILK 或音频文件）：主进程用
  // `localfilevoice` 把 SILK 解码成 WAV 再流回来（浏览器放不了 SILK）。乐观渲染的
  // 录音带 `localPreviewUrl`（blob: 的 webm/opus），浏览器能直接播，无需 SILK 解码。
  const localPath = str(data, 'localPath');
  const localPreviewUrl = str(data, 'localPreviewUrl');
  const waveform = Array.isArray(data.waveform) ? (data.waveform as number[]) : [];
  const voiceSource =
    localPreviewUrl ||
    (localPath
      ? localVoiceFileUrl(localPath)
      : mediaUrl('ptt', {
          t: sendTimeMs,
          name,
          token,
          msgId: mediaMsgId || msgId,
          conv,
          ...(fwd ? { fwdMsgId: fwd.fwdMsgId, fwdKind: fwd.fwdKind } : {}),
          ...(fwd?.fwdResId ? { fwdResId: fwd.fwdResId } : {}),
        }));
  // 同一条实时语音落库时只换查询地址，不打断已开始的播放。
  const playbackKey =
    mediaKey && token && !fwd && !localPath && !localPreviewUrl
      ? JSON.stringify([mediaKey, conv, sendTimeMs, name, token])
      : voiceSource;
  // Duration comes from the element (wire tag 45906), NOT the waveform: AI 声聊
  // clips carry a fixed 30-byte synthetic strip, so waveform.length/10 is wrong
  // for them. Fall back to the waveform only when duration is absent (0).
  const seconds =
    num(data, 'pttDuration') ||
    (waveform.length > 0 ? Math.max(1, Math.round(waveform.length / 10)) : 0);
  const voiceChanged = Boolean(data.voiceChanged);
  const isAiVoice = Boolean(data.isAiVoice);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);
  const playAttempt = useRef(0);

  const storedTranscript = str(data, 'pttTranscript');
  const active = useTabActive();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = wrapRef.current;
    if (!element || !active || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, name, sendTimeMs]);
  const transcribe = useVoiceTranscription(
    {
      t: sendTimeMs,
      name,
      token,
      msgId,
      ...(fwd
        ? { forward: { carrierId: mediaMsgId, kind: fwd.fwdKind, conv, resId: fwd.fwdResId } }
        : {}),
    },
    active && visible && !livePending && !storedTranscript && !localPreviewUrl && !localPath,
  );
  const canTranscribe = transcribe.available && !livePending && !localPreviewUrl && !localPath;
  const result = storedTranscript && transcribe.result?.automatic ? undefined : transcribe.result;
  const transcribeError =
    (storedTranscript ? null : transcribe.error) ??
    (result && !result.success ? (result.error ?? '识别失败') : null);
  const method =
    result?.success && !result.automatic && result.source
      ? result.source === 'qq'
        ? 'QQ 在线'
        : '本地模型'
      : null;
  const emotion = result?.emotion ?? null;
  const events = (result?.events ?? []).map(
    (event) => `${event.emoji ? `${event.emoji} ` : ''}${event.label}`,
  );

  useEffect(() => {
    // 消息身份变化时重置播放器；转写状态按消息身份存放在共享缓存中。
    setPlaying(false);
    setPlayError(false);
    playAttempt.current = 0;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
      }
      audioRef.current = null;
    };
  }, [playbackKey]);

  const toggle = (): void => {
    let audio = audioRef.current;
    if (!audio) {
      // mediaMsgId/conv/fwd 让主进程在本地 Ptt 文件缺失时能定位元素做 OIDB
      // 补全（转发子消息时是 carrier 的 msgId；`msgId` 留给转写写回用）。
      audio = new Audio(mediaRetryUrl(voiceSource, playAttempt.current));
      audio.onended = () => setPlaying(false);
      audio.onerror = () => {
        if (audioRef.current !== audio) return;
        setPlaying(false);
        setPlayError(true);
        audioRef.current = null;
        playAttempt.current++;
      };
      audioRef.current = audio;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      setPlayError(false);
      const current = audio;
      void audio
        .play()
        .then(() => {
          if (audioRef.current === current) setPlaying(true);
        })
        .catch(() => {
          if (audioRef.current !== current) return;
          setPlaying(false);
          setPlayError(true);
          audioRef.current = null;
          playAttempt.current++;
        });
    }
  };

  // Bar count tracks duration (QQ-style: longer clip → longer strip), with a
  // floor so short clips — notably AI 声聊, which are often 1–5s — always show a
  // visible waveform, and a cap so very long clips stay within the bubble (the
  // wave area also clips as a hard safety net; see .qq-media-voice-wave).
  const barCount = Math.max(12, Math.min(28, 8 + Math.round(seconds)));
  const bars = sampleBars(waveform, barCount);
  const shownTranscript =
    (result?.success ? (result.text ?? '') : null) ?? (storedTranscript || null);
  const hasResult = shownTranscript !== null || transcribeError !== null;
  const showResult = hasResult && !transcribe.collapsed;
  const canExpand = transcribe.collapsed && hasResult;
  const transcribeLabel = canExpand ? '展开文字' : transcribeError ? '重试转文字' : '转文字';

  return (
    <div className="qq-voice-wrap" ref={wrapRef}>
      <MessageLayoutChange
        anchor={wrapRef}
        details={[
          ['.qq-media-play-error', playError],
          [
            '.qq-voice-wrap > .weq-message-expansion',
            showResult,
            showResult && shownTranscript,
            showResult && transcribeError,
            showResult && result,
          ],
        ]}
      />
      <div className="qq-voice-row">
        <button
          type="button"
          className={cn('qq-media-voice qq-media-action', playing && 'is-playing')}
          aria-label={playError ? '重试播放语音' : playing ? '暂停语音' : '播放语音'}
          aria-pressed={playing}
          onKeyDown={mediaKeyDown}
          onClick={toggle}
        >
          <span className="qq-media-voice-play" aria-hidden>
            {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          </span>
          {isAiVoice ? (
            <span className="qq-media-voice-ai" title="AI 声聊">
              <Sparkles size={11} strokeWidth={2} aria-hidden />
              AI
            </span>
          ) : null}
          {voiceChanged ? (
            <Star
              size={13}
              strokeWidth={2}
              className="qq-media-voice-changed"
              aria-label="变声语音"
            />
          ) : null}
          <span className="qq-media-voice-wave" aria-hidden>
            {bars.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
              <i key={i} style={{ height: `${20 + Math.round((v / 255) * 80)}%` }} />
            ))}
          </span>
          {seconds > 0 ? (
            <span className="qq-media-voice-time">
              <span className="weq-number weq-number-inherit">{seconds}</span>″
            </span>
          ) : null}
        </button>
        {canExpand || (canTranscribe && (shownTranscript === null || transcribeError)) ? (
          <button
            type="button"
            className="qq-voice-transcribe-btn"
            title={canExpand ? '展开转文字结果' : '转文字'}
            onClick={(event) => {
              event.stopPropagation();
              if (canExpand) transcribe.setCollapsed(false);
              else transcribe.run();
            }}
            disabled={transcribe.busy}
          >
            {transcribe.busy ? (
              <Loader2 size={13} strokeWidth={2} className="weq-spin" aria-hidden />
            ) : (
              <FileText size={13} strokeWidth={2} aria-hidden />
            )}
            <span>{transcribe.busy ? '转写中' : transcribeLabel}</span>
          </button>
        ) : null}
      </div>

      {playError ? (
        <p className="qq-media-play-error" role="status">
          语音暂时无法播放，可重试。
        </p>
      ) : null}

      <MessageExpansion>
        {showResult ? (
          <MessageTextResult
            label="转文字结果"
            error={Boolean(transcribeError)}
            onCollapse={() => transcribe.setCollapsed(true)}
          >
            {!transcribeError && (method || emotion || events.length > 0) ? (
              <div className="qq-voice-tone">
                {method ? <span className="qq-voice-tone-chip">{method}</span> : null}
                {emotion ? (
                  <span className="qq-voice-tone-chip is-emotion">
                    {emotion.emoji ? `${emotion.emoji} ` : ''}
                    {emotion.label}
                  </span>
                ) : null}
                {events.map((ev) => (
                  <span key={ev} className="qq-voice-tone-chip">
                    {ev}
                  </span>
                ))}
              </div>
            ) : null}
            {shownTranscript !== null ? (
              <span data-privacy-sensitive={Boolean(shownTranscript) || undefined}>
                {shownTranscript || '（未识别到内容）'}
              </span>
            ) : null}
            {transcribeError ? <span role="status">{transcribeError}</span> : null}
          </MessageTextResult>
        ) : null}
      </MessageExpansion>
    </div>
  );
}

// ---- market face --------------------------------------------------------

export function QqMarketFace({ data, interactive = true }: { data: Data; interactive?: boolean }) {
  const deferred = useDataSaver((state) => state.enabled && !state.behavior.dataSaverEmoji);
  const browse = useContext(MediaBrowseContext);
  const pack = num(data, 'emojiPackId');
  const hash = str(data, 'marketEmoticonIdHex');
  const source = mediaUrl('mface', { pack, hash, ...(browse ? { intent: 'interactive' } : {}) });
  const media = useMediaLoadAction(source, '表情', deferred && !browse, true);
  const style = messageMediaSize('mface', data);
  if (!pack || !hash) {
    return <QqMediaMissing label="该表情" style={{ ...style, minWidth: 0, minHeight: 0 }} />;
  }
  // 商城表情与普通图片表情的差异：外层包一层带商城角标的容器，点击弹出
  // 贴近消息的整包小浮层（数据同构本地资源页的商城表情包）。
  const StickerControl = interactive ? 'button' : 'span';
  const label = media.ready ? '查看整组商城表情' : media.label;
  return (
    <StickerControl
      type={interactive ? 'button' : undefined}
      aria-label={interactive ? label : undefined}
      aria-busy={media.loading || undefined}
      data-load-action={interactive && !media.ready ? true : undefined}
      onKeyDown={interactive ? mediaKeyDown : undefined}
      className="qq-mface-wrap qq-media-action"
      data-favorite-emoji-source={mediaUrl('mface', { pack, hash })}
      style={style}
      title={interactive ? label : '商城表情'}
      onClick={
        interactive
          ? (event) => {
              const target = event.currentTarget;
              media.activate(() => openMarketFaceLightbox(String(pack), hash, target));
            }
          : undefined
      }
    >
      {media.hint ? (
        <QqMediaMissing
          label="该表情"
          hint={interactive ? media.hint : undefined}
          style={{ ...style, minWidth: 0, minHeight: 0, padding: 0 }}
        />
      ) : (
        <ShimmerImage
          suspendOffscreen
          reuseRemoteCache
          mediaLoading={media.loading}
          className="qq-media-mface"
          src={media.src}
          alt="[商城表情]"
          draggable={false}
          onLoad={media.onLoad}
          onError={media.onError}
        />
      )}
      <span className="qq-mface-badge" aria-hidden>
        <Store size={11} strokeWidth={2.4} />
      </span>
    </StickerControl>
  );
}

// ---- helpers ------------------------------------------------------------

function formatDuration(seconds: number): string {
  return timeFormat.formatDuration(Math.max(0, seconds), 'media');
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
