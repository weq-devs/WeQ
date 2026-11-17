/**
 * QQ 动态提示卡 (elementType=26 / QQ_DYNAMIC, QQ 内部名 TOFU)。
 *
 * 好友说说、生日礼物提醒、装扮变更、匿名问答回复、密友绑定……一整类"资料/空间动态"
 * 通知共用这一个 element，靠 `dynamicType` 区分场景（真实枚举含义见
 * docs/database/nt_msg/elements/qq-dynamic.md，是全表扫描实测出来的，不是猜的）。
 *
 * 之前这里直接复用 ark 卡片的 `weq-ark-*` 视觉语言、只画了 mainDesc/封面/空间
 * logo 四个字段，是当前渲染里信息损耗最大的一块：
 *   - mainDesc/subDesc 各带一个十六进制颜色（QQ 原生拿来给文案上色），完全没用到；
 *   - 发布者只有 uin/uid，没有昵称头像，之前干脆不显示是谁；
 *   - dynamicMeta 里的跳转链接 (jumpUrl/jump_h5) 没接，卡片点了没反应；
 *   - dynamicTags（如生日祝福语、装扮好评语）整个没画；
 *   - dynamicType=11（互动认证/认识多久）正文其实压根不在 mainDesc 里，而是塞在
 *     dynamicMeta 一段 base64 编码的嵌套 protobuf 里，之前完全是空的。
 *
 * subDesc 颜色只做成强调色圆点/顶栏，不直接套在文字上——那是 QQ 给浅色气泡背景
 * 设计的颜色（样本里出现过 #000000/#03081A 这种深色文案色），直接当文字色在 WeQ
 * 深色主题下会读不清，正文统一走主题色。
 */

import type { QqDynamic } from './QqDynamic';

export interface DynamicDesc {
  mainDesc?: string;
  subDesc?: string;
}

export interface DynamicTag {
  flag48191?: boolean;
  tagId?: number;
  tagContent?: string;
}

/** 普通气泡与系统消息共用完整载荷，避免外层分流丢失跳转或发布者字段。 */
export function qqDynamicElementProps(
  data: Record<string, unknown>,
): Parameters<typeof QqDynamic>[0] {
  return {
    dynamicType: data.dynamicType as number | undefined,
    desc: data.dynamicDesc as DynamicDesc | undefined,
    desc2: data.dynamicDesc2 as DynamicDesc | undefined,
    coverUrl: data.dynamicCoverUrl as string | undefined,
    zoneLogoUrl: data.dynamicZoneLogoUrl as string | undefined,
    publisherUin: data.dynamicPublisherUin as number[] | undefined,
    meta: data.dynamicMeta as string | undefined,
    tags: data.dynamicTags as DynamicTag[] | undefined,
  };
}
