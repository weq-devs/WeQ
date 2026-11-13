import { EventEmitter } from 'node:events';

export interface WebNotice {
  uin: string;
  configId: string;
  kind: 'recall' | 'keyword' | 'mail' | 'message';
  title: string;
  body: string;
  target?: { kind: 'c2c' | 'group'; conv: string; seq: string };
}
export const webNotices = new EventEmitter();
webNotices.setMaxListeners(0);
