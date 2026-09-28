/**
 * 「最近搜索」下拉 —— 搜索框刚点开、还什么都没输入时显示的那一份。
 *
 * 数据是 QQ 自己的 `nt_msg.db` / `search_history` 表（`searchHistory` IPC），
 * 一条 = 一个搜过的对象：好友 / 群友 / 群 / 群文件，外加命中的那一段名字。
 * 只展示「有什么」，不加说明性文案。
 */

import type { ReactElement } from 'react';
import type { SearchHistoryHit } from '@weq/service';
import { fileIconUrl } from '../../lib/resourceUrl';
import { formatSize } from '../../lib/groupFile';
import { SearchAvatar, c2cAvatarSrc, fileExtIcon, groupAvatarSrc } from './SearchResultCard';

/** 一行：头像/图标 + 名字 + 一行来源信息。 */
function HistoryRow({
  item,
  onSelect,
}: {
  item: SearchHistoryHit;
  onSelect: (item: SearchHistoryHit) => void;
}): ReactElement {
  let media: ReactElement;
  let title: string;
  let detail: string;

  switch (item.kind) {
    case 'friend':
      media = (
        <SearchAvatar
          url={c2cAvatarSrc(item.uin)}
          fallbackText={(item.name || item.nick).slice(0, 1)}
        />
      );
      title = item.name || item.nick;
      detail = item.uin;
      break;
    case 'groupMember':
      media = <SearchAvatar url={c2cAvatarSrc(item.uin)} fallbackText={item.name.slice(0, 1)} />;
      title = item.name;
      detail = item.groupName;
      break;
    case 'group':
      media = (
        <SearchAvatar url={groupAvatarSrc(item.groupCode)} fallbackText={item.name.slice(0, 1)} />
      );
      title = item.name;
      detail = item.groupCode;
      break;
    case 'file':
      media = (
        <img
          className="weq-search-file-icon"
          src={fileIconUrl(fileExtIcon(item.fileName))}
          alt=""
        />
      );
      title = item.fileName;
      detail = [
        item.groupName ? `来自${item.groupName}` : '',
        item.fileSize > 0 ? formatSize(item.fileSize) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      break;
  }

  return (
    <button type="button" className="weq-search-row" role="option" onClick={() => onSelect(item)}>
      {media}
      <span className="weq-search-text">
        <span className="weq-search-row-top">
          <span className="weq-search-name">{title}</span>
        </span>
        {detail ? <span className="weq-search-snippet">{detail}</span> : null}
      </span>
    </button>
  );
}

export function SearchHistoryPanel({
  items,
  onSelect,
}: {
  items: SearchHistoryHit[];
  onSelect: (item: SearchHistoryHit) => void;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="weq-search-dropdown" role="listbox" aria-label="最近搜索">
      {items.map((item, index) => (
        <HistoryRow
          key={`${item.kind}:${item.groupCode}:${item.uid}:${item.name}:${index}`}
          item={item}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
