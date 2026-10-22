import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { requireUid, requireUint32, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

function categoryName(name: string) {
  if (!name || name.trim() !== name || name.includes('\0') || Buffer.byteLength(name) > 255)
    throw new Error('分组名称须为 1 至 255 字节，且不能有首尾空白');
  return name;
}
const categorySchema = message([
  { name: 'id', tag: 1, type: 'uint32', force: true },
  { name: 'name', tag: 2, type: 'string', force: true },
  { name: 'sort', tag: 3, type: 'uint32', force: true },
]);
export namespace CreateFriendCategory {
  export const command = 0x1124;
  export const subCommand = 1;
  export const reqSchema = message([{ name: 'name', tag: 1, type: 'string' }]);
  export const respSchema = message([{ name: 'category', tag: 1, type: categorySchema }]);
  export const serialize = (p: { name: string }) => ({ name: categoryName(p.name) });
  export function deserialize(body: Record<string, unknown>) {
    const row = responseObject(body.category, '新建分组');
    if (typeof row.name !== 'string') throw new Error('新建分组响应缺少名称');
    return { id: requireUint32(Number(row.id), '分组 ID'), name: row.name };
  }
  export const invoke = (nt: OidbNative, pid: number, p: { name: string }) =>
    invokeOidb(nt, pid, CreateFriendCategory, p);
}
export namespace UpdateFriendCategories {
  export const command = 0x1126;
  export const subCommand = 1;
  export const reqSchema = message([
    { name: 'categories', tag: 1, repeated: true, type: categorySchema },
  ]);
  export const respSchema = message([]);
  export function serialize(p: {
    categories: Array<{ id: number; name?: string; sort?: number }>;
  }) {
    if (
      !p.categories.length ||
      new Set(p.categories.map((row) => row.id)).size !== p.categories.length
    )
      throw new Error('分组更新为空或重复');
    return {
      categories: p.categories.map((row) => ({
        id: requireUint32(row.id, '分组 ID', true),
        ...(row.name === undefined ? {} : { name: categoryName(row.name) }),
        ...(row.sort === undefined ? {} : { sort: requireUint32(row.sort, '分组排序', true) }),
      })),
    };
  }
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (nt: OidbNative, pid: number, p: Parameters<typeof serialize>[0]) =>
    invokeOidb(nt, pid, UpdateFriendCategories, p);
}
export namespace DeleteFriendCategory {
  export const command = 0x1125;
  export const subCommand = 1;
  export const reqSchema = message([{ name: 'categoryId', tag: 1, type: 'uint32' }]);
  export const respSchema = message([]);
  export function serialize(p: { categoryId: number }) {
    if (p.categoryId === 0) throw new Error('不能删除默认分组');
    return { categoryId: requireUint32(p.categoryId, '分组 ID') };
  }
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (nt: OidbNative, pid: number, p: { categoryId: number }) =>
    invokeOidb(nt, pid, DeleteFriendCategory, p);
}
export namespace MoveFriendCategory {
  export const command = 0x10eb;
  export const subCommand = 1;
  export const needSign = false;
  export const reqSchema = message([
    { name: 'uid', tag: 1, type: 'string' },
    { name: 'categoryId', tag: 2, type: 'uint32', force: true },
  ]);
  export const respSchema = message([]);
  export const serialize = (p: { uid: string; categoryId: number }) => ({
    uid: requireUid(p.uid),
    categoryId: requireUint32(p.categoryId, '分组 ID', true),
  });
  export const deserialize = (_body: Record<string, unknown>): void => {};
  export const invoke = (nt: OidbNative, pid: number, p: { uid: string; categoryId: number }) =>
    invokeOidb(nt, pid, MoveFriendCategory, p);
}
