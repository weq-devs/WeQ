import type { ForwardCacheKind } from '@weq/db';

export const MEDIA_SAVE_URL_KINDS = ['file', 'image', 'video', 'voice', 'emoji'] as const;

export type MediaSaveSource =
  | {
      kind: 'url';
      url: string;
      name?: string;
      mediaKind?: (typeof MEDIA_SAVE_URL_KINDS)[number];
      progressTarget?: string;
    }
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
  | {
      kind: 'group-file';
      groupCode: string;
      fileId: string;
      fileName: string;
      busId?: number;
      folderId?: string;
    };
