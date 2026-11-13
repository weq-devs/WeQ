import { useState } from 'react';
import { avatarFetchUrl } from '../../lib/resourceUrl';
import { fixProfileAvatarUrl } from '../../lib/avatarResolver';
import { HistoryValue } from '../ContactHistory';
import { MediaPreview } from '../MediaPreview';
import '../../styles/contact-history-avatar.css';

export function ContactHistoryAvatar({ value }: { value: unknown }) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value))
    return <HistoryValue value={value} />;
  // 历史头像按原地址取图，不能走按 QQ 号解析当前头像的 local-first 路径。
  const src = avatarFetchUrl(fixProfileAvatarUrl(value) ?? value);
  return <AvatarImage key={src} src={src} />;
}

function AvatarImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  return (
    <>
      {failed ? (
        <span className="weq-history-avatar-unavailable" role="status">
          图片暂不可用
        </span>
      ) : (
        <button
          type="button"
          className="weq-history-avatar"
          title="查看历史头像"
          aria-label="查看历史头像"
          onClick={() => setPreview(true)}
        >
          <img src={src} alt="历史头像" loading="lazy" onError={() => setFailed(true)} />
        </button>
      )}
      {preview ? (
        <MediaPreview
          label="历史头像预览"
          items={[{ key: src, kind: 'image', src, title: '历史头像' }]}
          onClose={() => setPreview(false)}
        />
      ) : null}
    </>
  );
}
