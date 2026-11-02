/**
 * 群礼物面板 —— `trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem`。
 *
 * 裸 SSO（无 OIDB 信封），不需要签名。请求 body 由真机抓包 RE 得到：
 *
 *   field 1  sceneId      string   场景 id，群礼物固定 `10012`
 *   field 2  extra        string   抓包里是空串，但**在 wire 上**（force 上空串）
 *   field 3  version      uint32   抓包固定 2
 *   field 5  client       message  客户端信息
 *            ├ 1 platform uint32   3（Android 客户端）
 *            └ 4 info     message  { 1 os / 2 version / 3 groupUin }
 *
 * 回包外层（本模块的 respSchema）：
 *
 *   field 4  panel    message  真正的面板数据
 *            ├ 1 panelId    string   形如 `025d64c9`
 *            ├ 2 panelName  string   抓包为「默认/兜底面板勿删」
 *            ├ 3 tabs       repeated 页签：id / name / sort / subtitle / gifts / attrs
 *            └ 7 attributes repeated KV（report tab / flow id）
 *   field 5  reports  repeated KV   外层上报字段（ReportTabID 等）
 *   field 6  sceneType uint32
 *   field 7  sceneLabel message    { 3 label }，抓包为「福利」
 *
 * 礼物条目（field 5）关键字段：`1` 条目 id、`2` 名称、`3` MarketingProductID、
 * `4` 场景 id、`5` 明细、`6` 角标、`8` 标语、`9` 属性 KV、`11` 排序、`12` 追踪信息。
 * 明细里 `1/14` 是礼物 id、`3` 等级、`4` 金币价、`9` 标签、`11` 图片资源。
 * 属性 KV 里的 `charm` 是魅力值、`desc` 是描述；卡片上「2金币 / 魅力值+2」就来自
 * `detail.price` 与 `attrs.charm`。
 *
 * 图片资源：field 11.2 里按文件名取 `staticPreviewImage.png`（静态预览）与
 * `dynamicPreviewImage.png`（动图）；`all.zip` 与 `*.pag` 是客户端素材，不用。
 */

import { decode, encode, message, type ProtoMessage } from '../../protobuf';
import { sendPacket, type TrpcNative } from '../../transport';

/** 群礼物面板的 SSO 命令字。 */
export const GROUP_GIFT_PANEL_CMD =
  'trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem';

/** 群礼物场景 id（抓包固定 10012）。 */
export const GROUP_GIFT_SCENE_ID = '10012';

/** 抓包里客户端上报的 Android QQ 版本；PC 凭据下服务端同样接受。 */
export const GROUP_GIFT_CLIENT_VERSION = '9.3.75.42350';

const KEY_VALUE: ProtoMessage = message([
  { name: 'key', tag: 1, type: 'string' },
  { name: 'value', tag: 2, type: 'string' },
]);

const CLIENT_INFO: ProtoMessage = message([
  { name: 'os', tag: 1, type: 'string' },
  { name: 'version', tag: 2, type: 'string' },
  { name: 'groupUin', tag: 3, type: 'string' },
]);

const REQUEST_CLIENT: ProtoMessage = message([
  { name: 'platform', tag: 1, type: 'uint32', force: true },
  { name: 'info', tag: 4, type: CLIENT_INFO },
]);

const GROUP_GIFT_PANEL_REQ: ProtoMessage = message([
  { name: 'sceneId', tag: 1, type: 'string' },
  { name: 'extra', tag: 2, type: 'string', force: true },
  { name: 'version', tag: 3, type: 'uint32' },
  { name: 'client', tag: 5, type: REQUEST_CLIENT },
]);

const RESOURCE: ProtoMessage = message([
  { name: 'name', tag: 1, type: 'string' },
  { name: 'url', tag: 2, type: 'string' },
]);

const GIFT_IMAGES: ProtoMessage = message([
  { name: 'animation', tag: 1, type: RESOURCE, repeated: true },
  { name: 'assets', tag: 2, type: RESOURCE, repeated: true },
  { name: 'baseUrl', tag: 3, type: 'string' },
]);

const GIFT_DETAIL: ProtoMessage = message([
  { name: 'giftId', tag: 1, type: 'uint32' },
  { name: 'name', tag: 2, type: 'string' },
  { name: 'level', tag: 3, type: 'uint32' },
  { name: 'price', tag: 4, type: 'uint32' },
  { name: 'tags', tag: 9, type: 'string', repeated: true },
  { name: 'images', tag: 11, type: GIFT_IMAGES },
  { name: 'resourceId', tag: 14, type: 'uint32' },
]);

const GIFT_CORNER: ProtoMessage = message([
  { name: 'id', tag: 1, type: 'uint32' },
  { name: 'label', tag: 2, type: 'string' },
  { name: 'iconUrl', tag: 3, type: 'string' },
  { name: 'kind', tag: 5, type: 'string' },
]);

const GIFT_TRACK: ProtoMessage = message([
  { name: 'traceId', tag: 1, type: 'string' },
  { name: 'resourceId', tag: 2, type: 'string' },
]);

const GIFT_ITEM: ProtoMessage = message([
  { name: 'id', tag: 1, type: 'uint32' },
  { name: 'name', tag: 2, type: 'string' },
  { name: 'productId', tag: 3, type: 'string' },
  { name: 'sceneId', tag: 4, type: 'string' },
  { name: 'detail', tag: 5, type: GIFT_DETAIL },
  { name: 'corner', tag: 6, type: GIFT_CORNER },
  { name: 'slogan', tag: 8, type: 'string' },
  { name: 'attributes', tag: 9, type: KEY_VALUE, repeated: true },
  { name: 'sort', tag: 11, type: 'uint32' },
  { name: 'track', tag: 12, type: GIFT_TRACK },
]);

const GIFT_TAB: ProtoMessage = message([
  { name: 'id', tag: 1, type: 'string' },
  { name: 'name', tag: 2, type: 'string' },
  { name: 'sort', tag: 3, type: 'uint32' },
  { name: 'subtitle', tag: 4, type: 'string' },
  { name: 'gifts', tag: 5, type: GIFT_ITEM, repeated: true },
  { name: 'attributes', tag: 6, type: KEY_VALUE, repeated: true },
]);

const PANEL_REPORT: ProtoMessage = message([
  { name: 'flowId', tag: 1, type: 'string' },
  { name: 'tabId', tag: 2, type: 'string' },
]);

const GIFT_PANEL: ProtoMessage = message([
  { name: 'panelId', tag: 1, type: 'string' },
  { name: 'panelName', tag: 2, type: 'string' },
  { name: 'tabs', tag: 3, type: GIFT_TAB, repeated: true },
  { name: 'report', tag: 7, type: PANEL_REPORT },
]);

/** 外层场景标题（field 7）：标签在子消息的 field 3。 */
const SCENE_LABEL: ProtoMessage = message([{ name: 'label', tag: 3, type: 'string' }]);

/** 回包外层：field 4 才是面板本体。 */
const GROUP_GIFT_PANEL_RESP: ProtoMessage = message([
  { name: 'panel', tag: 4, type: GIFT_PANEL },
  { name: 'reports', tag: 5, type: KEY_VALUE, repeated: true },
  { name: 'sceneType', tag: 6, type: 'uint32' },
  { name: 'sceneLabel', tag: 7, type: SCENE_LABEL },
]);

export interface GroupGiftPanelParams {
  /** 群号。 */
  groupUin: number | string;
  /** 场景 id，默认 10012（群礼物）。 */
  sceneId?: string;
  /** 客户端平台枚举，默认 3（Android）。 */
  platform?: number;
  /** 客户端版本号，默认抓包值。 */
  clientVersion?: string;
}

export interface GroupGiftImage {
  /** 静态预览图（列表 / 详情都用它）。 */
  staticUrl: string;
  /** 动态预览图（可能为空）。 */
  dynamicUrl: string;
  /** 素材根目录（`all.zip` 等资源相对它）。 */
  baseUrl: string;
}

export interface GroupGiftCorner {
  id: number;
  /** 角标文字（如「新」「热」）。 */
  label: string;
  iconUrl: string;
  /** 角标类型（抓包为 `live`）。 */
  kind: string;
}

export interface GroupGiftItem {
  /** 面板条目 id（稳定 key）。 */
  entryId: number;
  /** 礼物 id（明细里的 giftId，缺失时回落到 entryId）。 */
  giftId: number;
  name: string;
  /** 服务端商品标识（MarketingProductID）。 */
  productId: string;
  sceneId: string;
  /** 金币价。 */
  price: number;
  /** 魅力值（属性 KV 的 `charm`）。 */
  charm: number;
  /** 一句话描述（优先 `desc`，没有就用标语）。 */
  description: string;
  /** 卡片标语。 */
  slogan: string;
  /** 礼物等级。 */
  level: number;
  /** 分类标签。 */
  tags: string[];
  images: GroupGiftImage;
  corner?: GroupGiftCorner;
  /** 完整属性 KV（`desc` / `charm` / `giftType` / `MarketingProductID` …）。 */
  attributes: Record<string, string>;
  /** 服务端给的素材追踪信息，原样透传。 */
  track?: { traceId: string; resourceId: string };
}

export interface GroupGiftTab {
  id: string;
  name: string;
  subtitle: string;
  /** 是否粉丝团专属页签（属性 `isFanClubTab`）。 */
  isFanClub: boolean;
  gifts: GroupGiftItem[];
}

export interface GroupGiftPanelResult {
  /** 面板 id（服务端下发，形如 `025d64c9`）。 */
  panelId: string;
  /** 面板名（抓包里是「默认/兜底面板勿删」）。 */
  panelName: string;
  /** 场景标题（抓包为「福利」）。 */
  title: string;
  tabs: GroupGiftTab[];
  /** 面板级上报 id（`flowId` / `tabId`）。 */
  report: { flowId: string; tabId: string };
  /** 回包外层上报字段（`ReportTabID` / `ReportFlowID`）。 */
  reports: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

function kvList(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of asArray(value)) {
    const key = str(item.key);
    if (key) out[key] = str(item.value);
  }
  return out;
}

function assetUrl(images: Record<string, unknown>, name: string): string {
  for (const item of asArray(images.assets)) {
    if (str(item.name) === name && str(item.url)) return str(item.url);
  }
  return '';
}

function imagesOf(detail: Record<string, unknown>): GroupGiftImage {
  const images = asRecord(detail.images);
  return {
    staticUrl:
      assetUrl(images, 'staticPreviewImage.png') || assetUrl(images, 'dynamicPreviewImage.png'),
    dynamicUrl: assetUrl(images, 'dynamicPreviewImage.png'),
    baseUrl: str(images.baseUrl),
  };
}

function giftOf(raw: Record<string, unknown>): GroupGiftItem {
  const detail = asRecord(raw.detail);
  const attributes = kvList(raw.attributes);
  const entryId = num(raw.id);
  const corner = asRecord(raw.corner);
  return {
    entryId,
    giftId: num(detail.giftId) || entryId,
    name: str(raw.name) || str(detail.name),
    productId: str(raw.productId),
    sceneId: str(raw.sceneId),
    price: num(detail.price),
    charm: Number.parseInt(attributes.charm ?? '', 10) || 0,
    description: attributes.desc || str(raw.slogan),
    slogan: str(raw.slogan),
    level: num(detail.level),
    tags: Array.isArray(detail.tags) ? detail.tags.map(str).filter(Boolean) : [],
    images: imagesOf(detail),
    ...(str(corner.label) || str(corner.iconUrl)
      ? {
          corner: {
            id: num(corner.id),
            label: str(corner.label),
            iconUrl: str(corner.iconUrl),
            kind: str(corner.kind),
          },
        }
      : {}),
    attributes,
    ...(raw.track
      ? {
          track: {
            traceId: str(asRecord(raw.track).traceId),
            resourceId: str(asRecord(raw.track).resourceId),
          },
        }
      : {}),
  };
}

export namespace GroupGiftPanel {
  export const cmd = GROUP_GIFT_PANEL_CMD;
  /** 抓包确认这条命令不带 SecInfo，不签名。 */
  export const needSign = false;
  export const reqSchema = GROUP_GIFT_PANEL_REQ;
  export const respSchema = GROUP_GIFT_PANEL_RESP;

  export const serialize = (p: GroupGiftPanelParams): Record<string, unknown> => {
    const groupUin = String(p.groupUin ?? '').trim();
    if (!/^\d+$/.test(groupUin)) {
      throw new Error(`群礼物的 groupUin 必须是群号，收到 ${String(p.groupUin)}`);
    }
    return {
      sceneId: p.sceneId ?? GROUP_GIFT_SCENE_ID,
      extra: '',
      version: 2,
      client: {
        platform: p.platform ?? 3,
        info: {
          os: 'android',
          version: p.clientVersion ?? GROUP_GIFT_CLIENT_VERSION,
          groupUin,
        },
      },
    };
  };

  export const deserialize = (body: Record<string, unknown>): GroupGiftPanelResult => {
    const panel = asRecord(body.panel);
    const panelReport = asRecord(panel.report);
    return {
      panelId: str(panel.panelId),
      panelName: str(panel.panelName),
      title: str(asRecord(body.sceneLabel).label),
      report: { flowId: str(panelReport.flowId), tabId: str(panelReport.tabId) },
      reports: kvList(body.reports),
      tabs: asArray(panel.tabs).map((tab) => {
        const attributes = kvList(tab.attributes);
        return {
          id: str(tab.id),
          name: str(tab.name),
          subtitle: str(tab.subtitle),
          isFanClub: attributes.isFanClubTab === 'true',
          gifts: asArray(tab.gifts).map(giftOf),
        };
      }),
    };
  };

  /** 拉取群礼物面板。需要已 attach 的在线 QQ 进程，不需要签名。 */
  export const invoke = async (
    nt: TrpcNative,
    pid: number,
    params: GroupGiftPanelParams,
  ): Promise<GroupGiftPanelResult> => {
    const bytes = await sendPacket(nt, pid, cmd, encode(reqSchema, serialize(params)), needSign);
    return deserialize(decode(respSchema, bytes));
  };
}
