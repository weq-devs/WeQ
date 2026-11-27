import type { ProfilePerson } from '../../hooks/useContactCard';
import { useContactDress } from '../../hooks/useContactCard';
import { dressUrl } from '../../lib/resourceUrl';
import { useDataSaver } from '../../lib/dataSaver';
import { useMediaLoadAction } from '../../hooks/useMediaLoadAction';
import { ContactRow } from './ContactRow';
import { openMediaPreview } from '../mediaPreviewStore.shared';
import { Film } from 'lucide-react';
import { DressImage } from '../DressImage';
import { MediaLoadingRing } from '../TransferRing';

function ContactDressTile({ label, url }: { label: string; url: string }) {
  const deferred = useDataSaver((state) => state.enabled && !state.behavior.dataSaverDress);
  const media = useMediaLoadAction(dressUrl(url), label, deferred);

  return (
    <button
      type="button"
      className="weq-media-frame"
      title={media.label}
      aria-label={media.label}
      aria-busy={media.loading || undefined}
      onClick={(event) => {
        const ownerDocument = event.currentTarget.ownerDocument;
        media.activate(() => {
          openMediaPreview({
            items: [{ key: url, kind: 'image', src: media.src, title: label }],
            ownerDocument,
          });
        });
      }}
    >
      <DressImage
        placeholder
        reuseRemoteCache
        src={media.src}
        alt={label}
        loading={media.loading ? 'eager' : 'lazy'}
        onLoad={media.onLoad}
        onLoadFailed={media.onError}
      />
      {media.hint || media.loading ? (
        <span className="weq-media-load-hint" aria-hidden>
          {media.loading ? <MediaLoadingRing /> : media.hint}
        </span>
      ) : null}
    </button>
  );
}

/** 仅展示真实装扮素材，不再把头像或 QQ 秀重复嵌入装扮预览。 */
export function ContactDressRow({ person }: { person: ProfilePerson }) {
  const query = useContactDress(person.identityValue);
  const images = [
    { label: '名片装扮', url: query.data?.cardUrl },
    { label: '头像挂件', url: query.data?.widgetUrl },
    { label: '浮屏装扮', url: query.data?.screenUrl },
  ].filter((item): item is { label: string; url: string } => Boolean(item.url));
  const video = query.data?.cardVideoUrl;
  if (!images.length && !video) return null;
  return (
    <ContactRow label="个性装扮">
      <div className="weq-contact-dress-assets">
        {images.map((item) => (
          <ContactDressTile key={`${item.label}:${item.url}`} label={item.label} url={item.url} />
        ))}
        {video ? (
          <button
            type="button"
            title="查看名片视频"
            aria-label="查看名片视频"
            onClick={() =>
              openMediaPreview({
                items: [{ key: video, kind: 'video', src: dressUrl(video), title: '名片视频' }],
              })
            }
          >
            <Film size={24} />
          </button>
        ) : null}
      </div>
    </ContactRow>
  );
}
