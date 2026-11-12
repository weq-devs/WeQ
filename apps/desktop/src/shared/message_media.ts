export type MessageMediaTarget = {
  kind: 'pic' | 'emoji' | 'video' | 'ptt' | 'file' | 'mface';
  t: number;
  name: string;
  token: string;
  md5: string;
  msgId: string;
  conv: string;
  pack: string;
  hash: string;
  url?: string;
  favoriteUrl?: string;
  label: string;
};

export type MessageMediaLocationKind =
  | 'saved'
  | 'local'
  | 'cache'
  | 'thumbnail'
  | 'cover'
  | 'transcoded';

export interface MessageMediaLocation {
  kind: MessageMediaLocationKind;
  /** 绑定具体路径，点击时不悄悄切换到另一份副本。 */
  key: string;
  available: boolean;
}

export const MESSAGE_MEDIA_LOCATION_LABELS: Record<MessageMediaLocationKind, string> = {
  saved: '显示另存文件',
  local: '在文件夹中显示',
  cache: '显示缓存文件',
  thumbnail: '显示缓存缩略图',
  cover: '显示封面缓存',
  transcoded: '显示转码缓存',
};

export function messageMediaLocationMissing(kind: MessageMediaLocationKind): string {
  if (kind === 'saved') return '另存的文件已被移动或删除，请使用“另存为”重新保存';
  if (kind === 'local') return '下载的文件已被移动或删除，请使用“另存为”重新保存';
  return '这份缓存文件已不存在，请重新打开消息后再试';
}
