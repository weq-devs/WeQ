import { ExternalLink, Link2, Music2 } from 'lucide-react';
import { useContext, useState } from 'react';
import { openExternalLink } from '../lib/openExternalLink';
import { qzoneAlbumTarget, type QzoneFeedLink } from '../lib/qzone';
import { QzoneAlbumNavigationContext } from '../lib/qzoneNavigation';
import { albumMediaUrl } from '../lib/resourceUrl';
import { ShimmerImage } from './ShimmerImage';

export function QzoneFeedLinks({
  links,
  ownerUin,
  ownerNickname,
}: {
  links: QzoneFeedLink[];
  ownerUin?: string;
  ownerNickname?: string;
}) {
  const openAlbum = useContext(QzoneAlbumNavigationContext);
  const [error, setError] = useState('');
  return (
    <>
      {links.map((link) => (
        <button
          className="weq-qzn-feed-link"
          key={link.href}
          type="button"
          title={link.href}
          onClick={() => {
            setError('');
            const target = ownerUin ? qzoneAlbumTarget(link.href) : null;
            if (target && openAlbum) {
              const title = link.text.match(/《([^》]+)》/)?.[1] || link.text || '相册';
              openAlbum(
                target.hostUin,
                target.topicId,
                title,
                target.hostUin === ownerUin ? ownerNickname : undefined,
              );
              return;
            }
            void openExternalLink(link.href)
              .then((result) => {
                if (!result.ok) setError(result.error || '链接打开失败');
              })
              .catch((error: unknown) =>
                setError(error instanceof Error ? error.message : '加载失败，请重试。'),
              );
          }}
        >
          <FeedLinkCover
            key={link.cover || 'no-cover'}
            src={link.cover}
            music={link.kind === 'music'}
          />
          <span className="weq-qzn-feed-link-body">
            <strong data-privacy-sensitive>{link.text}</strong>
            {link.description ? <span>{link.description}</span> : null}
            <small>{link.source || new URL(link.href).hostname}</small>
          </span>
          <ExternalLink className="weq-qzn-feed-link-external" size={16} aria-hidden />
        </button>
      ))}
      {error ? <p className="weq-qzn-error">{error}</p> : null}
    </>
  );
}

function FeedLinkCover({ src, music }: { src?: string; music: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="weq-qzn-feed-link-cover weq-media-frame" aria-hidden>
      {src && !failed ? (
        <ShimmerImage
          src={albumMediaUrl(src)}
          alt=""
          loading="lazy"
          mediaLoading
          onError={() => setFailed(true)}
        />
      ) : music ? (
        <Music2 size={26} />
      ) : (
        <Link2 size={26} />
      )}
    </span>
  );
}
