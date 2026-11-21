import { Check, Images } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MultiSelectionItemProps } from '../hooks/useMultiSelection';
import { ShimmerImage } from './ShimmerImage';

export function QzoneAlbumTile({
  name,
  cover,
  coverAlt,
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
  subtitle: ReactNode;
  indicator?: ReactNode;
  sensitiveName?: boolean;
  selected: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  selectionProps?: MultiSelectionItemProps;
}) {
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
        onClick={onOpen}
        disabled={!onOpen}
        title={name}
      >
        <span className="weq-qzal-album-cover weq-media-frame">
          {cover ? (
            <ShimmerImage
              mediaLoading
              src={cover}
              alt={`${coverAlt}封面`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="weq-qzal-album-cover-empty">
              <Images size={22} aria-hidden />
            </span>
          )}
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
