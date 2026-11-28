import type { ForwardCacheKind } from '@weq/db';

export type MediaSaveSource =
  | { kind: 'url'; url: string; name?: string; progressTarget?: string }
  | {
      kind: 'chat-file';
      msgId: string;
      name?: string;
      token?: string;
      conv?: string;
      fwdMsgId?: string;
      fwdKind?: ForwardCacheKind;
      fwdResId?: string;
    }
  | { kind: 'group-file'; groupCode: string; fileId: string; fileName: string; busId?: number };
