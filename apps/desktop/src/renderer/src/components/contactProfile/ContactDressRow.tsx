import type { ProfilePerson } from '../../hooks/useContactCard';
import { useContactDress } from '../../hooks/useContactCard';
import { dressUrl } from '../../lib/resourceUrl';
import { ContactRow } from './ContactRow';
import { openMediaPreview } from '../mediaPreviewStore';
import { Film } from 'lucide-react';

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
          <button
            type="button"
            key={item.label}
            title={`查看${item.label}`}
            aria-label={`查看${item.label}`}
            onClick={() =>
              openMediaPreview({
                items: [
                  { key: item.url, kind: 'image', src: dressUrl(item.url), title: item.label },
                ],
              })
            }
          >
            <img src={dressUrl(item.url)} alt={item.label} loading="lazy" />
          </button>
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
