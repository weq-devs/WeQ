export type MediaSaveSource =
  | { kind: 'url'; url: string; name?: string }
  | {
      kind: 'chat-file';
      msgId: string;
      name?: string;
      token?: string;
      conv?: string;
      fwdMsgId?: string;
      fwdKind?: 'c2c' | 'group';
    }
  | { kind: 'group-file'; groupCode: string; fileId: string; fileName: string; busId?: number };
