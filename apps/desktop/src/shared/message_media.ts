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
