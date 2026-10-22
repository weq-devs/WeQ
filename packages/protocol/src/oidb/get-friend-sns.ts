import { message } from '../protobuf';
import { invokeOidb } from './invoke';
import { SNS_FRIEND_DISTURB } from './set-peer-preference';
import {
  SNS_SPECIAL_CARE,
  SNS_SPECIAL_CARE_ZONE,
  SNS_SPECIAL_CARE_RING,
} from './set-friend-special-care';
import { requireUid, requireUin, requireUint32, responseObject } from './write-validation';
import type { OidbNative } from '../transport';

export interface FriendSnsPage {
  selfUin?: string;
  cookie?: Uint8Array;
  isEnd?: boolean;
  categories?: Array<{
    id: number | null;
    name: string;
    buddyCount: number | null;
    sortOrder: number | null;
  }>;
  friends: Array<{
    uid: string;
    uin: string;
    disturb: boolean | null;
    disturbPresent: boolean;
    categoryId?: number;
    remark?: string;
    specialCare: {
      enabled: boolean | null;
      zone: boolean | null;
      ring: boolean | null;
      enabledPresent: boolean;
      zonePresent: boolean;
      ringPresent: boolean;
    };
  }>;
}

/** 0xFD4_1 完整名册查询；游标来自上一页，不使用增量缓存。 */
export namespace GetFriendSnsPage {
  export const command = 0xfd4;
  export const subCommand = 1;
  export const reqSchema = message([
    { name: 'count', tag: 2, type: 'uint32' },
    { name: 'field4', tag: 4, type: 'uint32', force: true },
    { name: 'cookie', tag: 5, type: 'bytes' },
    { name: 'field6', tag: 6, type: 'uint32' },
    { name: 'field7', tag: 7, type: 'uint32' },
    {
      name: 'profiles',
      tag: 10001,
      repeated: true,
      type: message([
        { name: 'type', tag: 1, type: 'uint32' },
        {
          name: 'filter',
          tag: 2,
          type: message([{ name: 'numbers', tag: 1, type: 'uint32', repeated: true }]),
        },
      ]),
    },
    { name: 'snsKeys', tag: 10002, type: 'uint32', repeated: true },
    { name: 'field10003', tag: 10003, type: 'uint32' },
  ]);
  export const respSchema = message([
    { name: 'cookie', tag: 2, type: 'bytes' },
    { name: 'isEnd', tag: 3, type: 'bool', force: true },
    { name: 'selfUin', tag: 7, type: 'uint64' },
    {
      name: 'friends',
      tag: 101,
      repeated: true,
      type: message([
        { name: 'uid', tag: 1, type: 'string' },
        { name: 'categoryId', tag: 2, type: 'uint32', force: true },
        { name: 'uin', tag: 3, type: 'uint64' },
        {
          name: 'additional',
          tag: 10001,
          repeated: true,
          type: message([
            { name: 'type', tag: 1, type: 'uint32' },
            {
              name: 'layer',
              tag: 2,
              type: message([
                {
                  name: 'properties',
                  tag: 2,
                  repeated: true,
                  type: message([
                    { name: 'code', tag: 1, type: 'uint32' },
                    { name: 'value', tag: 2, type: 'bytes', force: true },
                  ]),
                },
              ]),
            },
          ]),
        },
        {
          name: 'sns',
          tag: 10002,
          repeated: true,
          type: message([
            { name: 'key', tag: 1, type: 'uint32' },
            { name: 'value', tag: 2, type: 'bytes', force: true },
          ]),
        },
      ]),
    },
    {
      name: 'categories',
      tag: 102,
      repeated: true,
      type: message([
        { name: 'id', tag: 1, type: 'uint32', force: true },
        { name: 'name', tag: 2, type: 'string' },
        { name: 'buddyCount', tag: 3, type: 'uint32', force: true },
        { name: 'sortOrder', tag: 4, type: 'uint32', force: true },
      ]),
    },
  ]);
  export function serialize(p: { cookie?: Uint8Array }): Record<string, unknown> {
    return {
      count: 300,
      field4: 0,
      field6: 1,
      field7: 0x7fffffff,
      profiles: [
        { type: 1, filter: { numbers: [103, 102, 20002, 27394] } },
        { type: 4, filter: { numbers: [100, 101, 102] } },
      ],
      snsKeys: [13578, SNS_FRIEND_DISTURB, 13573, 13572, 13568],
      field10003: 4051,
      ...(p.cookie?.length ? { cookie: p.cookie } : {}),
    };
  }
  export function deserialize(
    body: Record<string, unknown>,
    options: { includeDirectory?: boolean; includeRemark?: boolean } = {},
  ): FriendSnsPage {
    if (
      body.selfUin === undefined &&
      body.cookie === undefined &&
      body.friends === undefined &&
      body.isEnd === undefined
    )
      throw new Error('好友名册响应为空或无法识别');
    const seen = new Set<string>();
    const friends = ((body.friends ?? []) as unknown[]).map((entry) => {
      const row = responseObject(entry, '好友');
      const uid = requireUid(String(row.uid));
      if (seen.has(uid)) throw new Error('好友名册返回重复目标');
      seen.add(uid);
      const keys = new Set<number>();
      let disturb: boolean | null = null;
      const specialCare: FriendSnsPage['friends'][number]['specialCare'] = {
        enabled: null,
        zone: null,
        ring: null,
        enabledPresent: false,
        zonePresent: false,
        ringPresent: false,
      };
      for (const raw of (row.sns ?? []) as unknown[]) {
        const item = responseObject(raw, '好友 SNS');
        const key = requireUint32(Number(item.key), 'SNS 标识');
        if (keys.has(key)) throw new Error('好友名册返回重复 SNS 属性');
        keys.add(key);
        if (
          ![
            SNS_FRIEND_DISTURB,
            SNS_SPECIAL_CARE,
            SNS_SPECIAL_CARE_ZONE,
            SNS_SPECIAL_CARE_RING,
          ].includes(key)
        )
          continue;
        if (!(item.value instanceof Uint8Array)) throw new Error('好友 SNS 属性缺少值');
        const bytes = item.value;
        if (key !== SNS_FRIEND_DISTURB) {
          const field =
            key === SNS_SPECIAL_CARE ? 'enabled' : key === SNS_SPECIAL_CARE_ZONE ? 'zone' : 'ring';
          specialCare[`${field}Present`] = true;
          specialCare[field] =
            bytes.length === 0
              ? false
              : field !== 'ring'
                ? true
                : bytes.length === 1 && bytes[0] === 49
                  ? true
                  : null;
          continue;
        }
        if (bytes.length === 0) disturb = false;
        else if (bytes.length === 8 && bytes.subarray(4).every((byte) => byte === 0xff))
          disturb = true;
      }
      let remark: string | undefined;
      for (const raw of (options.includeDirectory === false && !options.includeRemark
        ? []
        : (row.additional ?? [])) as unknown[]) {
        const additional = responseObject(raw, '好友资料');
        if (additional.type !== 1 || !additional.layer) continue;
        const layer = responseObject(additional.layer, '好友资料层');
        for (const rawProperty of (layer.properties ?? []) as unknown[]) {
          const property = responseObject(rawProperty, '好友属性');
          if (property.code !== 103) continue;
          if (remark !== undefined) throw new Error('好友备注属性重复');
          if (!(property.value instanceof Uint8Array)) throw new Error('好友备注缺少值');
          remark = new TextDecoder('utf-8', { fatal: true }).decode(property.value);
        }
      }
      return {
        uid,
        uin: requireUin(String(row.uin)).toString(),
        disturb,
        disturbPresent: keys.has(SNS_FRIEND_DISTURB),
        specialCare,
        ...(options.includeDirectory === false || row.categoryId === undefined
          ? {}
          : { categoryId: requireUint32(Number(row.categoryId), '好友分组', true) }),
        ...(remark === undefined ? {} : { remark }),
      };
    });
    return {
      ...(body.selfUin === undefined
        ? {}
        : { selfUin: requireUin(String(body.selfUin)).toString() }),
      ...(body.cookie instanceof Uint8Array ? { cookie: body.cookie } : {}),
      ...(typeof body.isEnd === 'boolean' ? { isEnd: body.isEnd } : {}),
      friends,
      ...(options.includeDirectory === false || body.categories === undefined
        ? {}
        : {
            categories: (body.categories as unknown[]).map((raw) => {
              const row = responseObject(raw, '好友分组');
              if (typeof row.name !== 'string') throw new Error('好友分组缺少名称');
              return {
                id: row.id === undefined ? null : requireUint32(Number(row.id), '好友分组', true),
                name: row.name,
                buddyCount:
                  row.buddyCount === undefined
                    ? null
                    : requireUint32(Number(row.buddyCount), '分组人数', true),
                sortOrder:
                  row.sortOrder === undefined
                    ? null
                    : requireUint32(Number(row.sortOrder), '分组排序', true),
              };
            }),
          }),
    };
  }
  export const invoke = (
    nt: OidbNative,
    pid: number,
    p: { cookie?: Uint8Array; includeDirectory?: boolean; includeRemark?: boolean },
  ): Promise<FriendSnsPage> =>
    invokeOidb(
      nt,
      pid,
      {
        ...GetFriendSnsPage,
        deserialize: (body) =>
          deserialize(body, {
            includeDirectory: p.includeDirectory,
            includeRemark: p.includeRemark,
          }),
      },
      p,
    );
}
