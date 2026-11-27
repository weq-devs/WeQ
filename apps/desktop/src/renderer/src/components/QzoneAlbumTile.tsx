import { Check, Images } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { MultiSelectionItemProps } from '../hooks/useMultiSelection';
import { useAlbumMediaLoadAction } from '../hooks/useMediaLoadAction';
import { ShimmerImage } from './ShimmerImage';
import { MediaLoadingRing } from './TransferRing';

export function QzoneAlbumTile({
  name,
  cover,
  coverAlt,
  videoPreviewSource,
  subtitle,
  indicator,
  sensitiveName,
  selected,
  onSelect,
  onOpen,
  selectionProps,
}: {
  name: string;
  cover: string;
  coverAlt: string;
  /** 独立视频网格在打开预览前先读封面，缺封面时原位准备第一帧。 */
  videoPreviewSource?: string;
  subtitle: ReactNode;
  indicator?: ReactNode;
  sensitiveName?: boolean;
  selected: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  selectionProps?: MultiSelectionItemProps;
}) {
  const [unusableCover, setUnusableCover] = useState<string>();
  const previewVideo = videoPreviewSource !== undefined;
  const prepareVideo = previewVideo && (!cover || cover === unusableCover);
  const media = useAlbumMediaLoadAction(prepareVideo ? videoPreviewSource : cover, coverAlt);
  return (
    <div className={`weq-qzal-album-card${selected ? ' is-checked' : ''}`} {...selectionProps}>
      {onSelect ? (
        <button
          type="button"
          className={`weq-qzal-media-check${selected ? ' is-on' : ''}`}
          aria-label={`选择${coverAlt} ${name}`}
          aria-pressed={selected}
          onClick={onSelect}
        >
          {selected ? <Check size={12} /> : null}
        </button>
      ) : null}
      <button
        type="button"
        className="weq-qzal-album-open"
        onClick={onOpen && (previewVideo ? () => media.activate(onOpen) : onOpen)}
        disabled={!onOpen}
        aria-busy={media.loading || undefined}
        aria-label={previewVideo ? `${media.label}：${name}` : undefined}
        title={previewVideo ? media.label : name}
      >
        <span className="weq-qzal-album-cover weq-media-frame">
          {prepareVideo && media.requested ? (
            <video
              key={media.src}
              src={media.src}
              preload="auto"
              muted
              playsInline
              onLoadedData={media.onLoad}
              onError={media.onError}
            />
          ) : !prepareVideo && cover ? (
            <ShimmerImage
              mediaLoading
              reuseRemoteCache
              src={media.src}
              alt={`${coverAlt}封面`}
              loading={media.loading ? 'eager' : 'lazy'}
              referrerPolicy="no-referrer"
              onLoad={previewVideo ? media.onLoad : undefined}
              onError={
                previewVideo
                  ? () => {
                      media.onError();
                      if (media.requested && videoPreviewSource) setUnusableCover(cover);
                    }
                  : undefined
              }
            />
          ) : (
            <span className="weq-qzal-album-cover-empty">
              <Images size={22} aria-hidden />
            </span>
          )}
          {prepareVideo && media.loading ? <MediaLoadingRing label="正在加载视频" /> : null}
          {previewVideo && media.hint ? (
            <span className="weq-media-load-hint" aria-hidden>
              {media.hint}
            </span>
          ) : null}
          {indicator}
        </span>
        <span className="weq-qzal-album-meta">
          <strong data-privacy-sensitive={sensitiveName || undefined}>{name}</strong>
          <small>{subtitle}</small>
        </span>
      </button>
    </div>
  );
}
