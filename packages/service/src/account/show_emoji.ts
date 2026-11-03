/**
 * QQ 秀 / 互动表情目录。
 *
 * 数据源是 `resources/qqshow/show_emoji.json` —— `OidbSvcTrpcTcp.0x957b_0` 的离线快照
 * （48 个表情包）。该接口跟其它 QQ 秀命令一样按 Android appid 放行，PC/Linux 调用一律
 * 返回 `319 rule type not match appid`，所以只能固化，不能实时拉取。
 *
 * 本模块只做两件事：
 *   1. 读快照并整理成前端好用的形状（按类型分组、带图标 URL）；
 *   2. 把「表情包 + 变体」拼成发送时 `extBizInfo.pic.bytesPbReserveC2c` 里的
 *      `36`（互动表情包定义）+ `35`（类型标记）。
 *
 * 拼 `36` 的依据来自真机发送包的字段布局（2026-10-31 / 11-01 两份抓包），
 * 已用它们回验：发送包里 `19[i]` 的 `primary/secondary` 组合能在目录的 `variants`
 * 里精确命中，因此反向拼装是可靠的。
 */

import { encode, message, type ProtoMessage } from '@weq/protocol';

/** 表情包类型（目录里的 `type` 字段）。 */
export const SHOW_EMOJI_TYPE = { action: 1, duo: 2, chain: 3 } as const;

/** 目录里的一个变体（`variants[i]`）。 */
export interface ShowEmojiVariant {
  /** 主元素组（`19.1`）。 */
  primary?: { packId: string; elementIds: string[] };
  /** 副元素组（`19.2`），接龙类的另一侧。 */
  secondary?: { packId: string; elementIds: string[] };
  /** 主元素组的镜像副本（`19.3`），目前与 primary 同值。 */
  mirror?: { packId: string; elementIds: string[] };
  /** `19.4` 标记。 */
  flag?: number;
}

/** 布局帧（`20/21/22` 的每一条，也对应目录里的 `preview.frames`）。 */
export interface ShowEmojiFrame {
  /** 帧时间（毫秒）。 */
  time?: number;
  /** 总时长。 */
  totalTime?: number;
  /** 三个布局 float（抓包里是 750 / 3000 / 1200 这类值）。 */
  x?: number;
  y?: number;
  scale?: number;
}

/** 目录里的一个表情包。 */
export interface ShowEmojiPack {
  id: string;
  seq: number;
  name: string;
  type: number;
  typeName: string;
  /** 效果理想图（72×72 PNG）。 */
  iconUrl: string;
  /** 玩法包 id。 */
  actionPackId: string;
  /** 动作名（「互动动作」/「接龙动作」）。 */
  actionName: string;
  /** 元素 id 列表（顶层 `7`）。 */
  elementIds: string[];
  /**
   * 元素组（顶层 `10`）。
   *
   * 只有「接龙」类和部分「双人互动」带它；「互动动作」类（`哈哈哈` / `点赞`…）
   * 没有 `10`，也**没有 `13` 变体列表** —— 那类只有 `7` + `8`/`9` 预览规格，
   * 发送时不需要拼 `36` 的变体段。
   */
  elementGroup?: { packId: string; elementIds: string[] };
  version?: number;
  preview?: {
    packId?: string;
    elementId?: string;
    color?: { stroke?: string; fill?: string };
    width?: number;
    height?: number;
    frames?: ShowEmojiFrame[];
  };
  /**
   * 变体列表（顶层 `13`）。可能为空 —— 「互动动作」类整类都没有这个字段。
   */
  variants: ShowEmojiVariant[];
}

/** `show_emoji.json` 的顶层结构。 */
export interface ShowEmojiCatalogFile {
  source: { command: string; capturedAt: string; packCount: number };
  packs: ShowEmojiPack[];
}

// ─────────────────────────── 拼 36 ───────────────────────────

/**
 * `19` 的每一条（一个变体）。
 *
 * ⚠️ 真机里这些是**平铺的标量**，不是嵌套 message —— 抓包字节 `9a 01 c2 01`
 * 后面直接跟 `0a 0a "30000000xx"`（field1 长度 10 的字符串）。早期版本错写成
 * `{1: {packId, elementIds}}` 嵌套，每条多出 102 字节，收端直接回退默认表情。
 *
 * 结构：`1` 主包 id、`2` ×N 主元素 id、`3` 副包 id、`4` ×N 副元素 id、`5` 标记。
 */
const SHOW_EMOJI_VARIANT = message([
  { name: 'primaryPackId', tag: 1, type: 'string' },
  { name: 'primaryElementIds', tag: 2, type: 'string', repeated: true },
  { name: 'secondaryPackId', tag: 3, type: 'string' },
  { name: 'secondaryElementIds', tag: 4, type: 'string', repeated: true },
  { name: 'flag', tag: 5, type: 'uint32' },
]);

/** `20/21/22` 的每条：时间轴 + 三个布局参数（fixed32 float）。 */
const SHOW_EMOJI_FRAME = message([
  { name: 'time', tag: 1, type: 'uint32' },
  { name: 'totalTime', tag: 2, type: 'uint32' },
  { name: 'x', tag: 3, type: 'float' },
  { name: 'y', tag: 4, type: 'float' },
  { name: 'scale', tag: 5, type: 'float' },
]);

/**
 * `pic.bytesPbReserveC2c` 的 `36`（互动表情包定义）。
 *
 * 字段顺序按真机抓包：`1/2/3/4/5/6/8/9/10/11/12/13/14/15/16/17/18/19/20/21/22`。
 * `3` 是发送者 uin —— 由调用方（发送链路）填，这里留空串，服务端/收端以消息头为准。
 */
const SHOW_EMOJI_PACK: ProtoMessage = message([
  { name: 'packId', tag: 1, type: 'string' },
  { name: 'elementIds', tag: 2, type: 'string', repeated: true },
  { name: 'senderUin', tag: 3, type: 'string' },
  { name: 'packId2', tag: 4, type: 'string' },
  { name: 'elementIds2', tag: 5, type: 'string', repeated: true },
  { name: 'field6', tag: 6, type: 'uint32' },
  { name: 'field8', tag: 8, type: 'uint32' },
  { name: 'strokeColor', tag: 9, type: 'string' },
  { name: 'fillColor', tag: 10, type: 'string' },
  { name: 'field11', tag: 11, type: 'uint32' },
  { name: 'field12', tag: 12, type: 'uint32' },
  { name: 'packId3', tag: 13, type: 'string' },
  { name: 'elementIds3', tag: 14, type: 'string', repeated: true },
  { name: 'name', tag: 15, type: 'string' },
  { name: 'field16', tag: 16, type: 'uint32' },
  { name: 'field17', tag: 17, type: 'uint32' },
  { name: 'field18', tag: 18, type: 'uint32' },
  { name: 'variants', tag: 19, type: SHOW_EMOJI_VARIANT, repeated: true },
  { name: 'frames', tag: 20, type: SHOW_EMOJI_FRAME, repeated: true },
  { name: 'frames2', tag: 21, type: SHOW_EMOJI_FRAME, repeated: true },
  { name: 'frames3', tag: 22, type: SHOW_EMOJI_FRAME, repeated: true },
]);

/** 拼好的一条互动包：`35` 的取值 + `36` 的字节。 */
export interface ShowEmojiReserve {
  /** `35`：互动表情类型，等于目录里的 `type`（1 互动动作 / 2 双人互动 / 3 接龙）。 */
  type: number;
  /** `36`：互动表情包定义。 */
  pack: Uint8Array;
}

/**
 * 把一个目录包 + 变体拼成发送用的 `35` / `36`。
 *
 * 两类包的形状不同，以两份真机抓包为准：
 *
 * **带 `13` 变体列表的包**（接龙类多数、少量互动动作，如「成语接龙」）——
 *   `1/2` = 当前变体的 primary，`4/5` = secondary，`13/14` = mirror，
 *   `16` = 目录 `type`，`18` = 1，`19` 逐条写 variants。
 *
 * **不带变体列表的包**（36 个，如「放烟花」——见 `~/Downloads` 2026-11-01 抓包）——
 *   真机用的是**图标预览**那组：`1/2` = `actionPackId` + `elementIds`，
 *   `4/5` = `preview.packId` + `preview.elementId`；**不写 `13/14`、不写 `18`、
 *   不写 `19`**，`16` 仍是目录 `type`。
 *
 * `35` 在两份抓包里分别取 1 / 3，正好等于两类的 `type`，不是写死的常量。
 *
 * @param pack      目录里的表情包
 * @param variant   变体下标（默认 0；越界回退第一个）
 * @param senderUin 发送者 uin 的十进制串（写进 `36.3`；不给则留空）
 */
export function buildShowEmojiReserve(
  pack: ShowEmojiPack,
  variant = 0,
  senderUin = '',
): ShowEmojiReserve {
  const chosen = pack.variants[variant] ?? pack.variants[0];
  const frames = Array.isArray(pack.preview?.frames) ? pack.preview.frames : [];
  const common = {
    senderUin,
    field6: 15,
    field8: 1,
    strokeColor: pack.preview?.color?.stroke ?? '#C2C2C2FF',
    fillColor: pack.preview?.color?.fill ?? '#E3E3E3FF',
    field11: 540,
    field12: 540,
    name: pack.name,
    field16: pack.type,
    field17: 2,
    // 布局帧：目录里没有这份数据（0x957b 只给图标规格 8/9），有才写。
    ...(frames.length > 0 ? { frames, frames2: frames, frames3: frames } : {}),
  };

  if (chosen?.primary) {
    const primary = chosen.primary;
    const secondary = chosen.secondary;
    const mirror = chosen.mirror ?? primary;
    const encoded = encode(SHOW_EMOJI_PACK, {
      packId: primary.packId,
      elementIds: primary.elementIds,
      packId2: secondary?.packId ?? primary.packId,
      elementIds2: secondary?.elementIds ?? primary.elementIds,
      packId3: mirror.packId,
      elementIds3: mirror.elementIds,
      field18: 1,
      // 19 的每条：平铺的主/副包 id 与元素 id（见 SHOW_EMOJI_VARIANT 的注释）。
      variants: pack.variants.map((v) => ({
        primaryPackId: v.primary?.packId,
        primaryElementIds: v.primary?.elementIds,
        secondaryPackId: v.secondary?.packId,
        secondaryElementIds: v.secondary?.elementIds,
        flag: v.flag,
      })),
      ...common,
    });
    return { type: pack.type, pack: encoded };
  }

  /*
   * 无变体包：`primary` 取目录的 `actionPackId` + `elementIds`（两者在真机上
   * 拼成 `3000000018` + `2000000139`），`secondary` 取图标预览那一组。
   * 目录缺这两项就无从拼起 —— 明确报错，不要发出一个半残的包。
   */
  if (!pack.actionPackId || pack.elementIds.length === 0 || !pack.preview?.packId) {
    throw new Error(`表情包 ${pack.id}（${pack.name}）缺少可用的发送元素`);
  }
  const encoded = encode(SHOW_EMOJI_PACK, {
    packId: pack.actionPackId,
    elementIds: pack.elementIds,
    packId2: pack.preview.packId,
    elementIds2: pack.preview.elementId ? [pack.preview.elementId] : [],
    ...common,
  });
  return { type: pack.type, pack: encoded };
}

// ─────────────────────────── 目录读取 ───────────────────────────

/** 读取目录快照并按类型分组。`read` 由应用层注入（它知道 resources 根在哪）。 */
export function groupShowEmojiPacks(packs: ShowEmojiPack[]): Array<{
  type: number;
  typeName: string;
  packs: ShowEmojiPack[];
}> {
  const order = [SHOW_EMOJI_TYPE.action, SHOW_EMOJI_TYPE.duo, SHOW_EMOJI_TYPE.chain];
  const byType = new Map<number, ShowEmojiPack[]>();
  for (const pack of packs) {
    const list = byType.get(pack.type) ?? [];
    list.push(pack);
    byType.set(pack.type, list);
  }
  const result: Array<{ type: number; typeName: string; packs: ShowEmojiPack[] }> = [];
  for (const type of order) {
    const list = byType.get(type);
    if (!list?.length) continue;
    result.push({
      type,
      typeName: list[0]!.typeName,
      packs: [...list].sort((a, b) => a.seq - b.seq),
    });
  }
  return result;
}

/** 从目录里找包；找不到返回 null。 */
export function findShowEmojiPack(packs: ShowEmojiPack[], packId: string): ShowEmojiPack | null {
  return packs.find((pack) => pack.id === packId) ?? null;
}

/** 目录快照的合法性校验（配置坏了要明确报错，不要静默当空目录）。 */
export function parseShowEmojiCatalog(raw: unknown): ShowEmojiCatalogFile {
  const record = raw as Record<string, unknown>;
  if (!record || typeof record !== 'object' || !Array.isArray(record.packs)) {
    throw new Error('QQ 秀表情目录格式不正确：缺少 packs 数组');
  }
  const packs = record.packs as ShowEmojiPack[];
  for (const pack of packs) {
    if (!pack?.id || !pack.name || typeof pack.type !== 'number') {
      throw new Error(`QQ 秀表情目录条目缺少必要字段：${JSON.stringify(pack).slice(0, 120)}`);
    }
    if (!Array.isArray(pack.variants)) pack.variants = [];
  }
  return record as unknown as ShowEmojiCatalogFile;
}

// ─────────────────────────── 目录服务 ───────────────────────────

export interface ShowEmojiCatalogOptions {
  /**
   * 读目录快照的原始 JSON 文本。由应用层注入 —— 它知道 `resources` 根在哪
   * （Electron 打包后是 `process.resourcesPath`，dev 下是仓库 `resources/`）。
   * 返回 `null` 表示文件缺失。
   */
  readFile: () => string | null;
}

/**
 * QQ 秀表情目录服务。
 *
 * 只读、进程内缓存：目录是静态快照，进程生命周期内不会变。文件缺失或格式坏时
 * **明确报错**而不是返回空目录 —— 空目录会让 UI 显示「没有表情」，掩盖配置问题。
 */
export class ShowEmojiCatalog {
  private cache: ShowEmojiCatalogFile | null = null;

  constructor(private readonly opts: ShowEmojiCatalogOptions) {}

  /** 全部表情包（按 seq 排序）。 */
  list(): ShowEmojiPack[] {
    return [...this.catalog().packs].sort((a, b) => a.seq - b.seq);
  }

  /** 按类型分组（互动动作 / 双人互动 / 接龙）。 */
  groups(): Array<{ type: number; typeName: string; packs: ShowEmojiPack[] }> {
    return groupShowEmojiPacks(this.catalog().packs);
  }

  /** 按 id 找包；找不到返回 null。 */
  find(packId: string): ShowEmojiPack | null {
    return findShowEmojiPack(this.catalog().packs, packId);
  }

  /**
   * 拼出发送用的 `35` + `36`。
   *
   * @param packId     目录里的表情包 id
   * @param variant    变体下标（默认 0）
   * @param senderUin  发送者 uin（写进 `36.3`）
   */
  buildReserve(packId: string, variant = 0, senderUin = ''): ShowEmojiReserve {
    const pack = this.find(packId);
    if (!pack) throw new Error(`QQ 秀表情包不存在：${packId}`);
    return buildShowEmojiReserve(pack, variant, senderUin);
  }

  private catalog(): ShowEmojiCatalogFile {
    if (this.cache) return this.cache;
    const text = this.opts.readFile();
    if (text === null) {
      throw new Error('找不到 QQ 秀表情目录（resources/qqshow/show_emoji.json）');
    }
    this.cache = parseShowEmojiCatalog(JSON.parse(text));
    return this.cache;
  }
}
