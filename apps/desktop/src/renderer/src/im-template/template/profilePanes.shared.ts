import type { ProfileExtInfo } from './types';
import '../../styles/group-profile.css';
import '../../styles/contact-profile.css';
import { zodiac } from '../../lib/contactListOrder';

/** 由出生月日推算星座名（标准日期分界）。缺月或日时返回 null。 */
export function constellationOf(month?: number, day?: number) {
  return zodiac(month, day);
}

export function birthdayText(year?: number, month?: number, day?: number) {
  if (!month || !day) {
    return null;
  }
  return year && year > 0 ? `${year} 年 ${month} 月 ${day} 日` : `${month} 月 ${day} 日`;
}

/**
 * 特权 bizId → 名称。QQ 的特权位很多，这里只标注常见的几个；未知 id 退化成
 * 「特权 N」，图标本身仍然照常渲染（图标 URL 自带等级，视觉上不丢信息）。
 */
const PRIVILEGE_NAMES: Record<number, string> = {
  1: '超级会员',
  102: '黄钻',
  103: '音乐包',
  113: '大会员',
  118: '绿钻',
  119: '情侣特权',
};

function privilegeName(bizId?: number) {
  if (bizId == null) {
    return '特权';
  }
  return PRIVILEGE_NAMES[bizId] ?? `特权 ${bizId}`;
}

/** 国/省/市三级去重拼接（QQ 常只填其中一两级，重复的省市也要合掉）。 */
function regionText(ext?: ProfileExtInfo | null) {
  if (!ext) {
    return null;
  }
  const parts: string[] = [];
  for (const part of [ext.country, ext.province, ext.city]) {
    const value = part?.trim();
    if (value && !parts.includes(value)) {
      parts.push(value);
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * 从一张精选图片的多尺寸变体里挑 URL。档位实测 1=原图 2=640 3=160 4=100，
 * 缩略图优先 160、大图优先 640（原图往往几 MB，点开看也用不着）。
 */
function albumUrl(photo: ProfileExtInfo['album'][number], preferred: number[]): string | null {
  for (const size of preferred) {
    const hit = photo.urls.find((u) => u.size === size && u.url);
    if (hit?.url) {
      return hit.url;
    }
  }
  return photo.urls.find((u) => u.url)?.url ?? null;
}

/**
 * 把资料里的扩展字段（21000 列）翻成个性主页要的形状。
 *
 * 联系人详情复用个性主页内容，只传 `extInfo` 和显示字段，不依赖资料来源。
 */
export function toPersonalityProfile(
  base: { name: string; avatarUrl: string | null; signature?: string | null },
  ext?: ProfileExtInfo | null,
) {
  return {
    ...base,
    isEnterprise: ext?.isEnterprise,
    interests: (ext?.interests ?? []).filter((tag) => tag.trim()),
    privileges: (ext?.privileges ?? [])
      .filter((item) => item.opened && item.iconUrl)
      .map((item) => ({
        bizId: item.bizId,
        level: item.level,
        iconUrl: item.iconUrl,
        label: privilegeName(item.bizId),
      })),
    region: regionText(ext),
    album: (ext?.album ?? [])
      .map((photo) => ({
        thumb: albumUrl(photo, [3, 4, 2]) ?? '',
        full: albumUrl(photo, [2, 1, 3]) ?? '',
      }))
      .filter((p) => p.thumb && p.full),
  };
}

export function genderLabel(value?: number) {
  if (value === 1) {
    return '男';
  }
  if (value === 2) {
    return '女';
  }
  return null;
}
