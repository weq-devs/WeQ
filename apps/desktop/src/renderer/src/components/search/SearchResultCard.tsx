/** Renders one unified-search hit as a card (dropdown row + "more" modal row). */

import type { ReactElement } from 'react';
import { Bookmark, UsersRound } from 'lucide-react';
import { fileIconUrl } from '../../lib/resourceUrl';
import { AvatarPicture } from '../AvatarPicture';
import { resolveAvatar } from '../../lib/avatarResolver';
import type { SearchHit } from './types';
import { searchHitKey } from './types';
import { PersonRelationshipStatus, GroupRelationshipStatus } from '../RelationshipStatus';
import { classifyChatType } from '@weq/codec';
import { isInlineSearchHit } from './searchNavigation';
import { SEARCH_CATEGORY_ICONS } from './searchIcons';
import {
  createSearchHighlighter,
  groupAvatarSrc,
  c2cAvatarSrc,
  fileExtIcon,
} from './SearchResultCard.shared';

export function SearchAvatar({
  url,
  group,
}: {
  url: string | null | undefined;
  group?: boolean;
}): ReactElement {
  return <AvatarPicture className="weq-search-avatar" src={url} group={group} />;
}

/** One card. `subtitle` renders the gray second line; `media` the left icon. */
export function SearchResultCard({
  hit,
  keyword,
  onSelect,
  keepOpen = false,
}: {
  hit: SearchHit;
  keyword: string;
  onSelect?: (hit: SearchHit, focusKey?: string) => void;
  keepOpen?: boolean;
}): ReactElement {
  const literal = createSearchHighlighter(keyword);
  const names = createSearchHighlighter(keyword, true);
  const findMatchedAlias = (aliases: string[]) =>
    aliases.find(literal.matches) ?? aliases.find(names.matches);
  let media: ReactElement;
  let title: string;
  let subtitle: ReactElement;

  switch (hit.category) {
    case 'contact': {
      const conversationKind = classifyChatType(hit.chatType ?? 1);
      const sourceLabel =
        conversationKind === 'official'
          ? '公众号'
          : conversationKind === 'service'
            ? '服务号'
            : conversationKind === 'dataline'
              ? '数据线'
              : null;
      const matchedAlias = findMatchedAlias(
        hit.aliases.filter(
          (alias) =>
            alias !== hit.nick &&
            alias !== hit.remark &&
            alias !== (hit.uin || hit.uid) &&
            !hit.groups.some((group) => group.display === alias),
        ),
      );
      media = (
        <SearchAvatar url={resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl })} />
      );
      title = hit.remark || hit.nick || hit.uin || hit.uid;
      subtitle = (
        <span className="weq-search-muted">
          {hit.target?.kind === 'persona' ? (
            '克隆体'
          ) : hit.target?.kind === 'guild' ? (
            '频道私聊'
          ) : sourceLabel ? (
            sourceLabel
          ) : (
            <PersonRelationshipStatus
              person={{ id: hit.uid, identityValue: hit.uin, isFriend: hit.isFriend }}
              compact
            />
          )}
          {!hit.target && !sourceLabel && !hit.isFriend
            ? ` · ${hit.temporary ? '临时会话' : hit.hasConversation ? '本地会话' : '本地资料'}`
            : null}
          {' · '}
          <span data-privacy-sensitive>{literal.render(hit.uin || hit.uid)}</span>
          {hit.nick && hit.nick !== title ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{names.render(hit.nick)}</span>
            </>
          ) : null}
          {matchedAlias ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{names.render(matchedAlias)}</span>
            </>
          ) : null}
        </span>
      );
      break;
    }
    case 'group': {
      const matchedAlias = findMatchedAlias(
        hit.aliases.filter(
          (alias) => alias !== hit.name && alias !== hit.remark && alias !== hit.groupCode,
        ),
      );
      media = <SearchAvatar url={hit.target ? null : groupAvatarSrc(hit.groupCode)} group />;
      title = hit.remark || hit.name || hit.groupCode;
      subtitle = (
        <span className="weq-search-muted">
          {hit.target ? (
            '克隆体群聊'
          ) : (
            <GroupRelationshipStatus
              group={{ id: hit.groupCode, listed: hit.inDirectory, membershipKnown: true }}
              compact
            />
          )}
          {!hit.target && !hit.inDirectory
            ? ` · ${hit.hasConversation ? '本地群会话' : '本地群资料'}`
            : null}
          {' · '}
          <span data-privacy-sensitive>{literal.render(hit.groupCode)}</span>
          {hit.name && hit.name !== title ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{names.render(hit.name)}</span>
            </>
          ) : null}
          {matchedAlias ? (
            <>
              {' '}
              · <span data-privacy-sensitive>{names.render(matchedAlias)}</span>
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
    case 'guildMessage':
    case 'groupBulletin':
    case 'groupEssence':
    case 'flashFile':
    case 'qzoneComment':
    case 'otherQzoneComment':
    case 'qzonePublicComment': {
      const Icon = SEARCH_CATEGORY_ICONS[hit.category];
      media = (
        <span className="weq-search-avatar weq-search-source-icon" aria-hidden>
          <Icon size={22} strokeWidth={1.8} />
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
            {literal.render(hit.content)}
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
          <span data-privacy-sensitive>{literal.render(hit.content)}</span>
        </span>
      );
      break;
    }
    case 'cloneMessage':
    case 'assistantMessage': {
      const Icon = SEARCH_CATEGORY_ICONS[hit.category];
      media = (
        <span className="weq-search-avatar weq-search-source-icon" aria-hidden>
          <Icon size={22} strokeWidth={1.8} />
        </span>
      );
      title = hit.kind === 'assistant' ? hit.sessionTitle : hit.title;
      subtitle = (
        <span className="weq-search-muted">
          {hit.category === 'cloneMessage' ? '克隆' : 'WeQ 助手'} ·{' '}
          {hit.matchType === 'title' ? '标题命中' : '正文命中'} ·{' '}
          <span data-privacy-sensitive>{literal.render(hit.content)}</span>
        </span>
      );
      break;
    }
    case 'conversation': {
      const isGroup = hit.chatType === 2;
      media = (
        <SearchAvatar
          url={isGroup ? groupAvatarSrc(hit.targetUid) : c2cAvatarSrc(hit.targetUin)}
          group={isGroup}
        />
      );
      title = hit.name;
      subtitle = <span className="weq-search-muted">{hit.typeLabel}</span>;
      break;
    }
    case 'friend': {
      media = (
        <SearchAvatar url={resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl })} />
      );
      title = hit.nick || hit.remark || hit.uin;
      subtitle = (
        <span className="weq-search-mono" data-privacy-sensitive>
          {literal.render(hit.uin || hit.uid)}
        </span>
      );
      break;
    }
    case 'groupMember': {
      media = <SearchAvatar url={groupAvatarSrc(hit.groupCode)} group />;
      title = hit.groupName;
      subtitle = (
        <span className="weq-search-muted">
          包含<span data-privacy-sensitive>{names.render(hit.memberDisplay)}</span>
        </span>
      );
      break;
    }
    case 'chatRecord': {
      const isGroup = hit.source === 'group';
      media = (
        <SearchAvatar
          url={isGroup ? groupAvatarSrc(hit.targetUid) : c2cAvatarSrc(hit.targetUin)}
          group={isGroup}
        />
      );
      title = hit.name;
      subtitle = (
        <span className="weq-search-muted">
          {hit.count > 0 || !hit.matchedBulletins ? (
            <>
              查到
              <strong className="weq-search-strong">
                <span className="weq-number weq-number-inherit">{hit.count}</span>
              </strong>
              条包含
              <span data-privacy-sensitive>{literal.render(keyword)}</span>的消息
            </>
          ) : null}
          {hit.matchedBulletins ? (
            <>
              {hit.count > 0 ? ' · ' : ''}匹配
              <strong className="weq-search-strong">
                <span className="weq-number weq-number-inherit">{hit.matchedBulletins}</span>
              </strong>
              条群公告
            </>
          ) : null}
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
      data-search-keep-open={keepOpen || isInlineSearchHit(hit) || undefined}
      role="option"
      data-search-hit-key={searchHitKey(hit)}
      onClick={() => onSelect?.(hit)}
    >
      {media}
      <span className="weq-search-text">
        <span className="weq-search-row-top">
          <span className="weq-search-name">
            {hit.category === 'contact' || hit.category === 'group'
              ? names.render(title)
              : literal.render(title)}
          </span>
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
            <span data-privacy-sensitive>{names.render(group.display)}</span>
            <span>
              来自<span data-privacy-sensitive>{group.groupName}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
