import type { SearchCategory, SearchHit } from './types';
import { isQzoneSearchCategory } from '@weq/service/search-policy';

/** 搜索内继续浏览的明细；其它命中直接定位最终内容页或原消息。 */
export function isInlineSearchHit(hit: SearchHit): boolean {
  return (
    (hit.category === 'chatRecord' && !hit.matchedBulletins) ||
    ['groupEssence', 'flashFile', 'qzonePublicComment', 'groupAlbum', 'groupFile'].includes(
      hit.category,
    )
  );
}

export function searchHitParentCategory(hit: SearchHit): SearchCategory {
  if (isQzoneSearchCategory(hit.category) || hit.category === 'groupAlbum') return 'qzone';
  if (hit.category === 'groupFile' || hit.category === 'flashFile') return 'file';
  if (
    ['groupBulletin', 'groupEssence', 'guildMessage', 'cloneMessage', 'assistantMessage'].includes(
      hit.category,
    )
  )
    return 'chatRecord';
  return hit.category;
}
