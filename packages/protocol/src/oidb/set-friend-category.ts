import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUid, requireUint32 } from './write-validation';
import type { OidbNative } from '../transport';

export interface SetFriendCategoryParams {
  uid: string;
  categoryId: number;
}

export namespace SetFriendCategory {
  export const command = 0x1255;
  export const subCommand = 0;
  export const needSign = false;
  export const uinForm = true;
  export const reqSchema = message([
    { name: 'uid', tag: 1, type: 'string' },
    { name: 'categoryId', tag: 2, type: 'uint32', force: true },
  ]);
  export const respSchema = message([]);
  export const serialize = (p: SetFriendCategoryParams): Record<string, unknown> => ({
    uid: requireUid(p.uid),
    categoryId: requireUint32(p.categoryId, 'categoryId', true),
  });
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (nt: OidbNative, pid: number, p: SetFriendCategoryParams): Promise<void> =>
    invokeOidb(nt, pid, SetFriendCategory, p);
}
