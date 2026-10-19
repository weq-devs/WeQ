// 红包皮肤信息 — trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo
//
// 红包封皮（红包皮肤）的元数据查询：给定一个皮肤 id（skin_id），换回它的名称、
// 封面图 / 预览图 / 背景图等一组 CDN 外链，以及「领取同款封面」的跳转地址。
//
// 命令字本身已经说明了用途（红红包皮肤），请求 / 响应结构逐字段对照真机回包：
//
//   请求（43 字节）
//     f1 = trace id（UUID 字符串）。服务端**不回带、也不校验** —— 实测随机 v4 /
//          全零 / 非 UUID / 空串，回包逐字节完全一致，所以这里硬编码全零。
//     f3 = skin_id（红包皮肤 id）
//     f6 = 0（未见变化的开关）
//
//   响应
//     f1 = 服务端下发的 trace id（恒为固定值，与请求 f1 无关）
//     f4 = 皮肤详情
//     f5 = 缓存 TTL（秒）
//
// `needSign=false`：这条命令的 `SecSign/SecToken` 不需要，裸 body 直接发就回正常数据。

import { message } from '../../protobuf';
import { invokeTrpc, type TrpcSpec } from '../invoke';
import type { TrpcNative } from '../../transport';

const CMD = 'trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo';

/** 请求里 f1 的占位 trace id。服务端忽略它，固定用全零。 */
export const RED_PACK_SKIN_TRACE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * 一只红包皮肤的信息。
 *
 * `id`/`name`/`state` 是确定含义；其余字段是回包里逐个 tag 解出来的图链与文案，
 * 命名按「它是什么」而非「二进制文档怎么叫」，没有文档依据的不臆造语义。
 */
export interface RedPackSkinInfo {
  /** f4.1：皮肤 id（与请求 f3 一致）。 */
  id: number;
  /** f4.2：状态，1 = 生效/在售。 */
  state: number;
  /** f4.3：皮肤名称，如「生日祝福」。 */
  name: string;
  /** f4.4：来源标注 + 封面图。 */
  cover: RedPackSkinCover;
  /** f4.5：跳转按钮。 */
  jump: RedPackSkinJump;
  /** f4.8：主图（横幅 / 详情大头图）。 */
  image: string;
  /** f4.9：预览图（聊天列表小图）。 */
  preview: string;
  /** f4.10：弹窗预览图。 */
  popup: string;
  /** f4.11：封面背景。 */
  background: RedPackSkinImage;
  /** f4.21：补充文案（如「免费领取」），部分皮肤没有。 */
  label: string;
  /** f4.26：附加图，部分皮肤为空。 */
  extra: string;
}

/** f4.4：来源标注 + 封面图。 */
export interface RedPackSkinCover {
  /** f4.4.1：来源标注，如「腾讯设计开放平台」。 */
  label: string;
  /** f4.4.2：封面图外链。 */
  url: string;
}

/** f4.5：跳转按钮（一般指向「领取同款封面」页）。 */
export interface RedPackSkinJump {
  /** f4.5.1：按钮文案，如「领取同款封面」。 */
  label: string;
  /** f4.5.2：跳转地址。 */
  url: string;
  /** f4.5.3：附加串，样本恒为空。 */
  extra: string;
}

/** f4.11：封面背景。 */
export interface RedPackSkinImage {
  /** f4.11.1：开关，样本恒为 0。 */
  flag: number;
  /** f4.11.2：图片外链。 */
  url: string;
  /** f4.11.3：附加串，样本恒为空。 */
  extra: string;
}

/** 整条响应：皮肤详情 + 服务端 trace id + TTL。 */
export interface RedPackSkinResponse {
  /** f1：服务端下发的 trace id。 */
  traceId: string;
  /** f4：皮肤详情；查不到皮肤时缺省。 */
  skin: RedPackSkinInfo | null;
  /** f5：缓存 TTL（秒）。 */
  ttl: number;
}

// ─────────────────────────── schema ───────────────────────────

const REQ = message([
  { name: 'traceId', tag: 1, type: 'string' },
  { name: 'skinId', tag: 3, type: 'uint32' },
  { name: 'flag', tag: 6, type: 'uint32', force: true },
]);

const COVER = message([
  { name: 'label', tag: 1, type: 'string' },
  { name: 'url', tag: 2, type: 'string' },
]);

const JUMP = message([
  { name: 'label', tag: 1, type: 'string' },
  { name: 'url', tag: 2, type: 'string' },
  { name: 'extra', tag: 3, type: 'string' },
]);

const IMAGE = message([
  { name: 'flag', tag: 1, type: 'uint32' },
  { name: 'url', tag: 2, type: 'string' },
  { name: 'extra', tag: 3, type: 'string' },
]);

const SKIN = message([
  { name: 'id', tag: 1, type: 'uint32' },
  { name: 'state', tag: 2, type: 'uint32' },
  { name: 'name', tag: 3, type: 'string' },
  { name: 'cover', tag: 4, type: COVER },
  { name: 'jump', tag: 5, type: JUMP },
  { name: 'image', tag: 8, type: 'string' },
  { name: 'preview', tag: 9, type: 'string' },
  { name: 'popup', tag: 10, type: 'string' },
  { name: 'background', tag: 11, type: IMAGE },
  // f13 / f14 样本恒 0；f17 / f18 / f19 样本恒为空串，暂不建模。
  { name: 'label', tag: 21, type: 'string' },
  { name: 'extra', tag: 26, type: 'string' },
]);

const RESP = message([
  { name: 'traceId', tag: 1, type: 'string' },
  { name: 'skin', tag: 4, type: SKIN },
  { name: 'ttl', tag: 5, type: 'uint32' },
]);

function readImage(value: unknown): RedPackSkinImage {
  const o = (value as Record<string, unknown> | undefined) ?? {};
  return { flag: Number(o.flag ?? 0), url: String(o.url ?? ''), extra: String(o.extra ?? '') };
}

export namespace GetRedPackSkin {
  export const cmd = CMD;
  export const needSign = false;
  export const reqSchema = REQ;
  export const respSchema = RESP;

  export interface Params {
    /** 红包皮肤 id（请求 f3）。 */
    skinId: number;
    /** 覆盖 trace id（请求 f1）；缺省用全零占位，服务端并不校验。 */
    traceId?: string;
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    traceId: p.traceId ?? RED_PACK_SKIN_TRACE_ID,
    skinId: p.skinId,
    flag: 0,
  });

  export const deserialize = (body: Record<string, unknown>): RedPackSkinResponse => {
    const rawSkin = body.skin as Record<string, unknown> | undefined;
    const rawCover = rawSkin?.cover as Record<string, unknown> | undefined;
    const rawJump = rawSkin?.jump as Record<string, unknown> | undefined;
    return {
      traceId: String(body.traceId ?? ''),
      ttl: Number(body.ttl ?? 0),
      skin: rawSkin
        ? {
            id: Number(rawSkin.id ?? 0),
            state: Number(rawSkin.state ?? 0),
            name: String(rawSkin.name ?? ''),
            cover: { label: String(rawCover?.label ?? ''), url: String(rawCover?.url ?? '') },
            jump: {
              label: String(rawJump?.label ?? ''),
              url: String(rawJump?.url ?? ''),
              extra: String(rawJump?.extra ?? ''),
            },
            image: String(rawSkin.image ?? ''),
            preview: String(rawSkin.preview ?? ''),
            popup: String(rawSkin.popup ?? ''),
            background: readImage(rawSkin.background),
            label: String(rawSkin.label ?? ''),
            extra: String(rawSkin.extra ?? ''),
          }
        : null,
    };
  };

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: Params,
  ): Promise<RedPackSkinResponse> =>
    invokeTrpc(nt, pid, GetRedPackSkin as TrpcSpec<Params, RedPackSkinResponse>, params);
}
