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
  export const alreadyAppliedCode = 2_001_002;
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
  export async function invoke(
    nt: OidbNative,
    pid: number,
    p: SetFriendCategoryParams,
  ): Promise<void> {
    try {
      await invokeOidb(nt, pid, SetFriendCategory, p);
    } catch (error) {
      // 当前 native 仅提供固定前缀的错误字符串；兼容仅限此命令的已应用回执。
      if (
        !(error instanceof Error && error.message.startsWith(`OIDB error ${alreadyAppliedCode}:`))
      )
        throw error;
    }
  }
}
