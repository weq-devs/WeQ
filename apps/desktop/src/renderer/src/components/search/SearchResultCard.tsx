/** Renders one unified-search hit as a card (dropdown row + "more" modal row). */

import { useEffect, useState, type ReactElement } from 'react';
import { fileIconUrl } from '../../lib/resourceUrl';
import { cachedAvatarUrl } from '../../lib/avatarCache';
import { resolveAvatar } from '../../lib/avatarResolver';
import type { SearchHit } from './types';

/** Group avatar CDN: https://p.qlogo.cn/gh/<code>/<code>/0 */
export function groupAvatarSrc(groupCode: string): string | null {
  return groupCode ? `https://p.qlogo.cn/gh/${groupCode}/${groupCode}/0` : null;
}

/** C2C avatar CDN by QQ number: https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=<uin> */
export function c2cAvatarSrc(uin: string): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

function fileExtIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    doc: 'doc.png',
    docx: 'doc.png',
    xls: 'xls.png',
    xlsx: 'xls.png',
    ppt: 'ppt.png',
    pptx: 'ppt.png',
    pdf: 'pdf.png',
    zip: 'zip.png',
    '7z': 'zip.png',
    gz: 'zip.png',
    tar: 'zip.png',
    rar: 'rar.png',
    exe: 'exe.png',
    msi: 'exe.png',
    mp3: 'audio.png',
    wav: 'audio.png',
    flac: 'audio.png',
    aac: 'audio.png',
    ogg: 'audio.png',
    m4a: 'audio.png',
    mp4: 'video.png',
    avi: 'video.png',
    mov: 'video.png',
    mkv: 'video.png',
    flv: 'video.png',
    wmv: 'video.png',
    png: 'image.png',
    jpg: 'image.png',
    jpeg: 'image.png',
    gif: 'image.png',
    webp: 'image.png',
    bmp: 'image.png',
    svg: 'image.png',
    txt: 'txt.png',
    md: 'txt.png',
    log: 'txt.png',
    ai: 'ai.png',
    apk: 'apk.png',
    bak: 'bak.png',
    js: 'code.png',
    ts: 'code.png',
    jsx: 'code.png',
    tsx: 'code.png',
    py: 'code.png',
    java: 'code.png',
    c: 'code.png',
    cpp: 'code.png',
    cs: 'code.png',
    go: 'code.png',
    rs: 'code.png',
    html: 'code.png',
    css: 'code.png',
    dmg: 'dmg.png',
    ttf: 'font.png',
    otf: 'font.png',
    woff: 'font.png',
    woff2: 'font.png',
    ipa: 'ipa.png',
    key: 'keynote.png',
    xmind: 'mindmap.png',
    numbers: 'numbers.png',
    pages: 'pages.png',
    pkg: 'pkg.png',
    psd: 'ps.png',
    sketch: 'sketch.png',
  };
  return map[ext] ?? 'unknown.png';
}

function Avatar({
  url,
  fallbackText,
  className = 'weq-search-avatar',
}: {
  url: string | null | undefined;
  fallbackText?: string;
  className?: string;
}): ReactElement {
  const resolved = cachedAvatarUrl(url);
  const [failed, setFailed] = useState(false);

  // Reset the failure flag when the source changes.
  useEffect(() => setFailed(false), [resolved]);

  return (
    <span className={className}>
      {resolved && !failed ? (
        <img
          src={resolved}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="weq-search-avatar-fallback">{fallbackText ?? '?'}</span>
      )}
    </span>
  );
}

/** One card. `subtitle` renders the gray second line; `media` the left icon. */
export function SearchResultCard({
  hit,
  keyword,
  onSelect,
}: {
  hit: SearchHit;
  keyword: string;
  onSelect?: (hit: SearchHit) => void;
}): ReactElement {
  let media: ReactElement;
  let title: string;
  let subtitle: ReactElement;

  switch (hit.category) {
    case 'conversation': {
      const isGroup = hit.chatType === 2;
      media = (
        <Avatar
          url={isGroup ? groupAvatarSrc(hit.targetUid) : c2cAvatarSrc(hit.targetUin)}
          fallbackText={hit.name.slice(0, 1)}
        />
      );
      title = hit.name;
      subtitle = <span className="weq-search-muted">{hit.typeLabel}</span>;
      break;
    }
    case 'friend': {
      media = (
        <Avatar
          url={resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl })}
          fallbackText={hit.nick.slice(0, 1)}
        />
      );
      title = hit.nick || hit.remark || hit.uin;
      subtitle = <span className="weq-search-mono">{hit.uin || hit.uid}</span>;
      break;
    }
    case 'groupMember': {
      media = (
        <Avatar url={groupAvatarSrc(hit.groupCode)} fallbackText={hit.groupName.slice(0, 1)} />
      );
      title = hit.groupName;
      subtitle = (
        <span className="weq-search-muted">包含{highlightText(hit.memberDisplay, keyword)}</span>
      );
      break;
    }
    case 'chatRecord': {
      const isGroup = hit.source === 'group';
      media = (
        <Avatar
          url={isGroup ? groupAvatarSrc(hit.targetUid) : c2cAvatarSrc(hit.targetUin)}
          fallbackText={hit.name.slice(0, 1)}
        />
      );
      title = hit.name;
      subtitle = (
        <span className="weq-search-muted">
          查到<strong className="weq-search-strong">{hit.count}</strong>条包含
          {highlightText(keyword, keyword)}的聊天记录
        </span>
      );
      break;
    }
    case 'file': {
      media = (
        <img className="weq-search-file-icon" src={fileIconUrl(fileExtIcon(hit.fileName))} alt="" />
      );
      title = hit.fileName;
      subtitle = <span className="weq-search-muted">来自{hit.convName}</span>;
      break;
    }
  }

  return (
    <button type="button" className="weq-search-row" role="option" onClick={() => onSelect?.(hit)}>
      {media}
      <span className="weq-search-text">
        <span className="weq-search-row-top">
          <span className="weq-search-name">{title}</span>
        </span>
        <span className="weq-search-snippet">{subtitle}</span>
      </span>
    </button>
  );
}

/** Case-insensitive <mark> highlighting for a substring in a short string. */
export function highlightText(text: string, keyword: string): ReactElement {
  const lower = text.toLowerCase();
  const needle = keyword.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const at = lower.indexOf(needle);
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="weq-search-hl">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
