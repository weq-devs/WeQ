// 个性装扮资源的高层入口:给 item_id,拿可直接下载的外链。
//
// 底下是 scid 拼装 + GetUrl 换取两步,这里把它们合成一次调用,并按气泡/字体各自的
// 分包规则整理结果。

import type { TrpcNative } from '../transport';
import { getResourceUrls, type ResourceUrl } from './get-url';
import {
  BUBBLE_PARTS,
  PENDANT_PARTS,
  bubbleScid,
  fontScid,
  pendantScid,
  type BubblePart,
  type FontFamily,
  type PendantPart,
} from './scid';
import { VasBid } from './schemas';
import type { ScUpdateClient } from './session';

/** 一款气泡的全部可用资源。 */
export interface BubbleResources {
  itemId: number | string;
  /** 配置文件(动画定义、配色、九宫格参数)。必然存在。 */
  config?: ResourceUrl;
  /** 静态图资源包。 */
  staticZip?: ResourceUrl;
  /** 动效资源包。只有部分气泡有。 */
  otherZip?: ResourceUrl;
  /** 全部结果(含没取到的),便于排查。 */
  all: ResourceUrl[];
}

/**
 * 取一款气泡的全部资源。一次请求带上三个分包 —— 服务端支持批量,比逐个发省往返。
 *
 * `static.zip` / `other.zip` 不是每款都有;没有时对应字段为 undefined,
 * 在 {@link BubbleResources.all} 里能看到 `reason: 'no-such-part'`。
 */
export async function getBubbleResources(
  nt: TrpcNative,
  pid: number,
  itemId: number | string,
  client: ScUpdateClient = {},
): Promise<BubbleResources> {
  const all = await getResourceUrls(
    nt,
    pid,
    BUBBLE_PARTS.map((part) => ({ bid: VasBid.Bubble, scid: bubbleScid(itemId, part) })),
    client,
  );

  const pick = (part: BubblePart): ResourceUrl | undefined => {
    const want = bubbleScid(itemId, part);
    const hit = all.find((r) => r.scid === want);
    return hit?.ok ? hit : undefined;
  };

  const out: BubbleResources = { itemId, all };
  const config = pick('config.json');
  const staticZip = pick('static.zip');
  const otherZip = pick('other.zip');
  if (config) out.config = config;
  if (staticZip) out.staticZip = staticZip;
  if (otherZip) out.otherZip = otherZip;
  return out;
}

/**
 * 取一款字体的资源(zip 内含一个 `<id>.ttf`)。
 *
 * 先按普通字体(`font.main.*`)查;若服务端回「资源不存在」,再按方正字体
 * (`font.fzfont.*`)重试一次 —— 两个字体族的 id 空间是分开的,光凭 id 判断不出属于哪族。
 */
export async function getFontResource(
  nt: TrpcNative,
  pid: number,
  itemId: number | string,
  client: ScUpdateClient = {},
): Promise<ResourceUrl | null> {
  const families: FontFamily[] = ['main', 'fzfont'];
  let lastMiss: ResourceUrl | null = null;

  for (const family of families) {
    const [hit] = await getResourceUrls(
      nt,
      pid,
      [{ bid: VasBid.Font, scid: fontScid(itemId, family) }],
      client,
    );
    if (hit?.ok) return hit;
    if (hit) lastMiss = hit;
  }
  return lastMiss;
}

/** 一款头像挂件的全部可用资源。 */
export interface PendantResources {
  itemId: number | string;
  /** 合成到头像上的挂件图。渲染必需,基本必然存在。 */
  image?: ResourceUrl;
  /** 动画/配置数据。 */
  xydata?: ResourceUrl;
  /** 动效资源包。只有部分挂件有。 */
  otherZip?: ResourceUrl;
  /** 全部结果(含没取到的),便于排查。 */
  all: ResourceUrl[];
}

/**
 * 取一款头像挂件的全部资源。一次请求带上三个分包,同 {@link getBubbleResources}。
 *
 * `xydata.js` / `other.zip` 不是每款都有;没有时对应字段为 undefined,
 * 在 {@link PendantResources.all} 里能看到 `reason: 'no-such-part'`。
 */
export async function getPendantResources(
  nt: TrpcNative,
  pid: number,
  itemId: number | string,
  client: ScUpdateClient = {},
): Promise<PendantResources> {
  const all = await getResourceUrls(
    nt,
    pid,
    PENDANT_PARTS.map((part) => ({ bid: VasBid.Pendant, scid: pendantScid(itemId, part) })),
    client,
  );

  const pick = (part: PendantPart): ResourceUrl | undefined => {
    const want = pendantScid(itemId, part);
    const hit = all.find((r) => r.scid === want);
    return hit?.ok ? hit : undefined;
  };

  const out: PendantResources = { itemId, all };
  const image = pick('aio_50.png');
  const xydata = pick('xydata.js');
  const otherZip = pick('other.zip');
  if (image) out.image = image;
  if (xydata) out.xydata = xydata;
  if (otherZip) out.otherZip = otherZip;
  return out;
}
