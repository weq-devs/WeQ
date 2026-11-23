import { createContext } from 'react';
import type { QzoneFeatureSection } from '@weq/service/feature-catalog';
import type { MfTarget } from '../components/mergeForward/model';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import type { QzoneHomeAlbumMedia } from './qzonePublic';

export interface QzoneSpaceRequest {
  accountUin: string;
  uin: string;
  nickname?: string;
  revision: string;
  target?: QzoneCardTarget;
  catalog?: { section: QzoneFeatureSection; source: string };
}

export function scopedQzoneRequest(request: QzoneSpaceRequest | null, source: string) {
  return request?.catalog && request.catalog.source !== source ? null : request;
}

export type QzoneCardTarget =
  | { kind: 'space'; uin: string }
  | { kind: 'unlocated-post'; uin: string }
  | {
      kind: 'post';
      uin: string;
      tid: string;
      commentId?: string;
      parentCommentId?: string;
      replyId?: string;
      commentText?: string;
    }
  | { kind: 'album'; uin: string; topicId: string };
export const QzoneCardNavigationContext = createContext<((target: QzoneCardTarget) => void) | null>(
  null,
);
export const QzonePublicNavigationContext = createContext<(() => void) | null>(null);

export const QzoneShareForwardContext = createContext<{
  targets: MfTarget[];
  send: (
    ark: string,
    target: MfTarget,
    binding: QQWriteBinding,
  ) => Promise<{ messageId: string } | undefined | 'unconfirmed'>;
} | null>(null);

/** 只接收可验证的空间永久链接，不从标题、摘要或图片链接推测身份。 */
export function qzoneCardTarget(value: string, depth = 0): QzoneCardTarget | null {
  try {
    if (value.length > 8192 || depth > 2) return null;
    const url = new URL(value);
    if (url.username || url.password || url.port) return null;
    if (url.protocol === 'mqqapi:' && url.hostname === 'qzoneschema') {
      const encoded = url.searchParams.get('schema');
      return encoded ? qzoneCardTarget(atob(encoded), depth + 1) : null;
    }
    if (url.protocol === 'mqzone:' && url.hostname === 'arouse' && url.pathname === '/detail') {
      const uin = url.searchParams.get('uin') ?? '';
      const tid = url.searchParams.get('cellid') ?? '';
      return url.searchParams.get('appid') === '311' &&
        /^[1-9]\d{4,19}$/.test(uin) &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(tid)
        ? { kind: 'post', uin, tid }
        : null;
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    if (url.hostname === 'user.qzone.qq.com') {
      const match = url.pathname.match(
        /^\/([1-9]\d{4,19})(?:\/(mood|photo)\/([a-zA-Z0-9_-]{1,256}))?\/?$/,
      );
      if (!match) return null;
      if (match[2] === 'mood') return { kind: 'post', uin: match[1]!, tid: match[3]! };
      if (match[2] === 'photo') return { kind: 'album', uin: match[1]!, topicId: match[3]! };
      // URL hash 中也可能携带内容路径，不把未知详情退化成主页。
      if (url.hash || url.search) return null;
      return { kind: 'space', uin: match[1]! };
    }
    if (!['mobile.qzone.qq.com', 'h5.qzone.qq.com', 'h5.qzone.qq.com.cn'].includes(url.hostname))
      return null;
    const uin = url.searchParams.get('uin') || url.searchParams.get('hostuin') || '';
    const tid = url.searchParams.get('tid') || url.searchParams.get('cellid') || '';
    if (!/^[1-9]\d{4,19}$/.test(uin) || !/^[a-zA-Z0-9_-]{1,128}$/.test(tid)) return null;
    return { kind: 'post', uin, tid };
  } catch {
    return null;
  }
}

export function qzoneDynamicTarget(meta?: string, dynamicType?: number): QzoneCardTarget | null {
  if (!meta || meta.length > 32768) return null;
  try {
    const data: unknown = JSON.parse(meta);
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const targets = ['jump_schema', 'jumpUrl', 'jump_h5'].flatMap((key) => {
      const target = typeof record[key] === 'string' ? qzoneCardTarget(record[key]) : null;
      return target ? [target] : [];
    });
    const target = targets.find((item) => item.kind !== 'space') ?? targets[0] ?? null;
    return target?.kind === 'space' && dynamicType === 2
      ? { kind: 'unlocated-post', uin: target.uin }
      : target;
  } catch {
    return null;
  }
}

/** Profile surfaces share the main workspace's account-scoped navigation. */
export const QzoneNavigationContext = createContext<
  ((uin: string, nickname?: string) => void) | null
>(null);

/** 空间头像共用主界面的账号资料卡入口。 */
export const QzoneProfileContext = createContext<
  ((uin: string, nickname: string, anchor: { x: number; y: number }) => void) | null
>(null);

export const QzonePersonContext = createContext<{
  spaceUin: string | null;
  action: 'profile' | 'space';
  onSpace: ((uin: string, nickname?: string) => void) | null;
}>({ spaceUin: null, action: 'space', onSpace: null });

export interface QzoneAlbumRequest {
  hostUin: string;
  topicId: string;
  name: string;
  revision: string;
}

export const QzoneAlbumNavigationContext = createContext<
  ((hostUin: string, topicId: string, name: string, ownerNickname?: string) => void) | null
>(null);

export type QzoneMediaDestination =
  | {
      kind: 'album';
      hostUin: string;
      topicId: string;
      media?: {
        picKey: string;
        kind: 'image' | 'video';
        src: string;
        poster?: string;
        isLivePhoto?: boolean;
      };
    }
  | { kind: 'post'; hostUin: string; tid: string };

export const QzoneMediaNavigationContext = createContext<{
  previewVisible: boolean;
  postAlbums?: ReadonlyMap<string, QzoneHomeAlbumMedia>;
  open: (target: QzoneMediaDestination, closePreview?: () => void) => void;
} | null>(null);
