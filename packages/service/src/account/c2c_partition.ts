import type { C2cPartition, UidMap } from '@weq/db';

/** 使用账号现有分区映射；缺失／普通补查失败保留完整读取，取消不触发回退扫描。 */
export async function resolveC2cPartition(uidMap: UidMap, peerUid: string): Promise<C2cPartition> {
  if (uidMap.sortNoByUid(peerUid) === undefined) {
    try {
      await uidMap.resolveSortNo?.(peerUid);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
    }
  }
  const sortNo = uidMap.sortNoByUid(peerUid);
  return sortNo !== undefined ? { sortNo } : { uid: peerUid };
}
