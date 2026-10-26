/** Renders one unified-search hit as a card (dropdown row + "more" modal row). */

import { useEffect, useState, type ReactElement } from 'react';
import {
  Bookmark,
  Bot,
  MessagesSquare,
  File,
  Globe,
  Hash,
  Images,
  Mail,
  Smile,
  UsersRound,
} from 'lucide-react';
import { fileIconUrl } from '../../lib/resourceUrl';
import { cachedAvatarUrl } from '../../lib/avatarCache';
import { resolveAvatar } from '../../lib/avatarResolver';
import type { SearchHit } from './types';
import { searchHitKey } from './types';

/** Group avatar CDN: https://p.qlogo.cn/gh/<code>/<code>/0 */
export function groupAvatarSrc(groupCode: string): string | null {
  return groupCode ? `https://p.qlogo.cn/gh/${groupCode}/${groupCode}/0` : null;
}

/** C2C avatar CDN by QQ number: https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=<uin> */
export function c2cAvatarSrc(uin: string): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

/** 文件名 → 通用文件图标（resources 里的 png 名）。 */
export function fileExtIcon(fileName: string): string {
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

/** 头像：加载失败/无地址时退回首字。搜索下拉与「最近搜索」共用。 */
export function SearchAvatar({
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
  onSelect?: (hit: SearchHit, focusKey?: string) => void;
}): ReactElement {
  let media: ReactElement;
  let title: string;
  let subtitle: ReactElement;

  switch (hit.category) {
    case 'contact': {
      const matchedAlias =
        keyword.trim() &&
        hit.aliases.find(
          (alias) =>
            alias.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()) &&
            alias !== hit.nick &&
            alias !== hit.remark &&
            !hit.groups.some((group) => group.display === alias),
        );
      media = (
        <SearchAvatar
          url={resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl })}
          fallbackText={(hit.remark || hit.nick || hit.uin || hit.uid).slice(0, 1)}
        />
      );
      title = hit.remark || hit.nick || hit.uin || hit.uid;
      subtitle = (
        <span className="weq-search-muted">
          {hit.target?.kind === 'persona'
            ? '克隆体'
            : hit.target?.kind === 'guild'
              ? '频道私聊'
              : hit.isFriend
                ? '好友'
                : hit.temporary
                  ? '临时会话'
                  : hit.hasConversation
                    ? '本地会话'
                    : '本地资料'}
          {' · '}
          <span data-privacy-sensitive>{highlightText(hit.uin || hit.uid, keyword)}</span>
          {hit.nick && hit.nick !== title ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{highlightText(hit.nick, keyword)}</span>
            </>
          ) : null}
          {matchedAlias ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{highlightText(matchedAlias, keyword)}</span>
            </>
          ) : null}
        </span>
      );
      break;
    }
    case 'group': {
      const matchedAlias =
        keyword.trim() &&
        hit.aliases.find(
          (alias) =>
            alias.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()) &&
            alias !== hit.name &&
            alias !== hit.remark,
        );
      media = (
        <SearchAvatar
          url={hit.target ? null : groupAvatarSrc(hit.groupCode)}
          fallbackText={hit.name.slice(0, 1)}
        />
      );
      title = hit.remark || hit.name || hit.groupCode;
      subtitle = (
        <span className="weq-search-muted">
          {hit.target
            ? '克隆体群聊'
            : hit.inDirectory
              ? '通讯录群聊'
              : hit.hasConversation
                ? '本地群会话'
                : '本地群资料'}
          {' · '}
          <span data-privacy-sensitive>{highlightText(hit.groupCode, keyword)}</span>
          {hit.name && hit.name !== title ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{highlightText(hit.name, keyword)}</span>
            </>
          ) : null}
          {matchedAlias ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{highlightText(matchedAlias, keyword)}</span>
            </>
          ) : null}
        </span>
      );
      break;
    }
    case 'qzonePost':
    case 'qzoneAlbum':
    case 'otherQzonePost':
    case 'otherQzoneAlbum':
    case 'groupAlbum':
    case 'groupFile':
    case 'mailMessage':
    case 'marketEmoji':
    case 'guildMessage': {
      const Icon =
        hit.category === 'mailMessage'
          ? Mail
          : hit.category === 'groupFile'
            ? File
            : hit.category === 'guildMessage'
              ? Hash
              : hit.category === 'marketEmoji'
                ? Smile
                : hit.target.kind === 'qzonePost'
                  ? Globe
                  : Images;
      media = (
        <span className="weq-search-avatar weq-search-source-icon">
          <Icon size={22} />
        </span>
      );
      title = hit.title;
      subtitle = (
        <span className="weq-search-muted">
          <span data-privacy-sensitive={hit.category !== 'marketEmoji' || undefined}>
            {hit.sourceName}
          </span>
          {' · '}
          <span data-privacy-sensitive={hit.category !== 'marketEmoji' || undefined}>
            {highlightText(hit.content, keyword)}
          </span>
        </span>
      );
      break;
    }
    case 'collection': {
      media = (
        <span className="weq-search-avatar weq-search-source-icon">
          <Bookmark size={22} />
        </span>
      );
      title = hit.title;
      subtitle = (
        <span className="weq-search-muted">
          {hit.sourceName ? (
            <>
              <span data-privacy-sensitive>{hit.sourceName}</span>
              {' · '}
            </>
          ) : (
            '本地收藏 · '
          )}
          <span data-privacy-sensitive>{highlightText(hit.content, keyword)}</span>
        </span>
      );
      break;
    }
    case 'cloneMessage':
    case 'assistantMessage': {
      media = (
        <span className="weq-search-avatar weq-search-source-icon">
          {hit.kind === 'assistant' ? <Bot size={22} /> : <MessagesSquare size={22} />}
        </span>
      );
      title = `${hit.title} · ${hit.sessionTitle}`;
      subtitle = (
        <span className="weq-search-muted">
          {hit.category === 'cloneMessage' ? '本地克隆对话' : '本地助手对话'} ·{' '}
          <span data-privacy-sensitive>{highlightText(hit.content, keyword)}</span>
        </span>
      );
      break;
    }
    case 'conversation': {
      const isGroup = hit.chatType === 2;
      media = (
        <SearchAvatar
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
        <SearchAvatar
          url={resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl })}
          fallbackText={hit.nick.slice(0, 1)}
        />
      );
      title = hit.nick || hit.remark || hit.uin;
      subtitle = (
        <span className="weq-search-mono" data-privacy-sensitive>
          {hit.uin || hit.uid}
        </span>
      );
      break;
    }
    case 'groupMember': {
      media = (
        <SearchAvatar
          url={groupAvatarSrc(hit.groupCode)}
          fallbackText={hit.groupName.slice(0, 1)}
        />
      );
      title = hit.groupName;
      subtitle = (
        <span className="weq-search-muted">
          包含<span data-privacy-sensitive>{highlightText(hit.memberDisplay, keyword)}</span>
        </span>
      );
      break;
    }
    case 'chatRecord': {
      const isGroup = hit.source === 'group';
      media = (
        <SearchAvatar
          url={isGroup ? groupAvatarSrc(hit.targetUid) : c2cAvatarSrc(hit.targetUin)}
          fallbackText={hit.name.slice(0, 1)}
        />
      );
      title = hit.name;
      subtitle = (
        <span className="weq-search-muted">
          查到<strong className="weq-search-strong">{hit.count}</strong>条包含
          <span data-privacy-sensitive>{highlightText(keyword, keyword)}</span>的消息
        </span>
      );
      break;
    }
    case 'file': {
      media = (
        <img className="weq-search-file-icon" src={fileIconUrl(fileExtIcon(hit.fileName))} alt="" />
      );
      title = hit.fileName;
      subtitle = (
        <span className="weq-search-muted">
          来自<span data-privacy-sensitive>{hit.convName}</span>
        </span>
      );
      break;
    }
  }

  const card = (
    <button
      type="button"
      className="weq-search-row"
      data-search-category={hit.category}
      role="option"
      data-search-hit-key={searchHitKey(hit)}
      onClick={() => onSelect?.(hit)}
    >
      {media}
      <span className="weq-search-text">
        <span className="weq-search-row-top">
          <span className="weq-search-name">{title}</span>
        </span>
        <span className="weq-search-snippet">{subtitle}</span>
      </span>
    </button>
  );
  if (hit.category !== 'contact' || hit.groups.length === 0) return card;
  return (
    <div className="weq-search-contact">
      {card}
      <div className="weq-search-contact-groups" aria-label="匹配的群名片">
        {hit.groups.map((group) => (
          <button
            key={group.groupCode}
            type="button"
            role="option"
            title={`打开群聊${group.groupName}`}
            data-search-hit-key={`${searchHitKey(hit)}:group:${group.groupCode}`}
            onClick={() =>
              onSelect?.(
                {
                  category: 'group',
                  groupCode: group.groupCode,
                  name: group.groupName,
                  remark: '',
                  inDirectory: false,
                  hasConversation: true,
                  aliases: [],
                },
                `${searchHitKey(hit)}:group:${group.groupCode}`,
              )
            }
          >
            <UsersRound size={14} aria-hidden />
            <span data-privacy-sensitive>{highlightText(group.display, keyword)}</span>
            <span>
              来自<span data-privacy-sensitive>{group.groupName}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
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
