/**
 * 元素打包器 —— 把「元素对象」打包成 `Elem` proto 对象（再由 `./send` 交给
 * `protobuf.encode` 序列化）。
 *
 * 这是收侧 `./decode` 的**镜像**，两边公用同一份 `./schemas`：
 *   decode：bytes --decode(ELEM)--> proto 树 --lift--> `{ kind, ... }`
 *   encode：`{ kind, ... }` --build--> proto 树 --encode(ELEM)--> bytes
 *
 * 元素对象的字段名刻意与 decode 的输出对齐（textContent / atTargetUid /
 * marketEmoticonId / markdownContent …），所以「收到一条 → 原样再发出去」（搬运、
 * 转发）可以把 `decodeMessage` 的 elements 直接喂给 {@link buildSendElems}，不需要
 * 中间结构。收侧当初为渲染做过的减法（MARKET_FACE 只留 5 个字段之类）已在
 * `./schemas` 补齐成收发共用。
 *
 * 覆盖的类型：
 *   - 纯打包（同步 {@link buildSendElems}）：text / at / face（含 svc33 小黄脸、
 *     svc37 超级表情）/ mface / reply / ark（json 卡片）/ xml / markdown /
 *     poke / forward（合并转发卡片）/ raw；
 *   - 需要先上传（异步 {@link buildSendElemsWithMedia}）：image / record / video ——
 *     先把文件传进 NTV2 拿到 msgInfo，再拼成 `commonElem { serviceType: 48 }`。
 *
 * 文件（file）不在其中：群文件 / 私聊文件是两条独立管线（群文件发布走 OIDB、私聊文件
 * 内容在 `messageBody.msgContent` 而不是 `richText.elems`），实现见 `../file/file-send`。
 * 想把收到的文件原样再发出去，目前只能用 `raw` 逃生舱。
 */

import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { MediaNative } from '../highway/ntv2-upload';
import {
  RICH_MEDIA_SERVICE_TYPE,
  type MediaSource,
  type MediaUploadResult,
  type MediaUploadTarget,
  uploadImageMsgInfo,
  uploadPttMsgInfo,
  uploadVideoMsgInfo,
} from '../highway/media-upload';
import type { PttWaveformSource } from '../highway/ptt-waveform';
import { encode } from '../protobuf';
import { ELEM, MARKDOWN_COMMON_PB, TEXT_PB_RESERVE } from './schemas';
import {
  EMOJI_BOUNCE_EXTRA,
  FLASH_PHOTO_PB,
  FLASH_PHOTO_SERVICE_TYPE,
  MARKET_FACE_PB_RESERVE,
  POKE_EXTRA,
  QFACE_EXTRA,
  QSMALL_FACE_EXTRA,
} from './send-schemas';

/** 发送场景 —— 少数元素受场景限制（比如窗口抖动只能私聊）。 */
export type SendScene = 'group' | 'c2c' | 'group-temp';

/** 纯文本（等价收侧 `{ kind: 'text', textContent }`）。 */
export interface SendTextElement {
  kind: 'text';
  textContent: string;
}

/**
 * @ 某人 / @全体成员。
 *
 * QQ 的 @ 是一个「文本 elem + pbReserve 里带目标 uid」的组合：文本决定显示，
 * pbReserve 决定通知。所以给 `atTargetUid` 才会有真正的提醒；只给 `atTargetUin`
 * 时服务端仍会解析（pbReserve 的 uin 槽位），但新版客户端以 uid 为准。
 */
export interface SendAtElement {
  kind: 'at';
  /** 显示文本，缺省按 `@uin `（全体成员为 `@全体成员 `）。 */
  textContent?: string;
  /** 目标 QQ 号；`all: true` 时忽略。 */
  atTargetUin?: number;
  /** 目标 uid（更可靠，建议带上）。 */
  atTargetUid?: string;
  /** @全体成员。 */
  all?: boolean;
}

/**
 * 系统表情。三条 wire 形态由调用方选定（本包不内置 0x9154_1 表情目录）：
 *   - 默认（无标记）        → 老 `FaceElem`，只对经典小黄脸有效；
 *   - `smallFace: true`     → commonElem serviceType=33 + QSmallFaceExtra；
 *   - `superSticker: {...}` → commonElem serviceType=37 + QFaceExtra（动态/超级表情）。
 *
 * 动态表情**不要**走默认那条：服务端会把 faceId 静默改写成另一张脸
 * （SnowLuma issue #168）。
 */
export interface SendFaceElement {
  kind: 'face';
  faceId: number;
  faceText?: string;
  smallFace?: boolean;
  superSticker?: SendSuperSticker;
}

/** 超级/动态表情所需的目录信息（packId/stickerId/stickerType 来自系统表情目录）。 */
export interface SendSuperSticker {
  packId: string;
  stickerId: string;
  stickerType?: number;
  sourceType?: number;
  randomType?: number;
  text?: string;
}

/**
 * 商城表情（mface）。`marketEmoticonId` 是 16 字节的贴纸 GUID：收侧 decode 给出
 * `Uint8Array`，手写时给 32 位 hex 字符串也行（两种都收）。
 */
export interface SendMfaceElement {
  kind: 'mface';
  marketEmoticonId: Uint8Array | string;
  emojiPackId: number;
  encryptKey?: string;
  /** 展示名（QQ 用它在面板里显示；缺省空串）。 */
  faceName?: string;
  subType?: number;
  previewWidth?: number;
  previewHeight?: number;
}

/** 引用回复（收侧 `{ kind: 'reply', origMsgSeq, origSenderUin, … }`）。 */
export interface SendReplyElement {
  kind: 'reply';
  /** 被引用消息的序列号（群聊=群内 seq，私聊=会话级 index）。 */
  origMsgSeq: number;
  origSenderUin?: number;
  origMsgTime?: number;
  /** 被引用消息的元素（会逐个编码成嵌套 Element bytes，缺省用 origElementsRaw）。 */
  origElements?: SendElement[];
  /** 已经编码好的嵌套 Element bytes，原样透传。 */
  origElementsRaw?: Uint8Array[];
}

/**
 * Ark / json 卡片 —— 一段 JSON 文本，编码成 `lightApp.data`（deflate + 0x01 头）。
 * 收侧 decode 把它 lift 成 `{ kind: 'ark', arkData }`，所以两边可以直接对喂。
 */
export interface SendArkElement {
  kind: 'ark';
  arkData: string;
}

/** XML 卡片（`richMsg`）：默认 serviceId=35（合并转发/一般卡片）。 */
export interface SendXmlElement {
  kind: 'xml';
  xmlContent: string;
  subType?: number;
}

/** Markdown 卡片（机器人消息正文）：commonElem serviceType=45 + MarkdownData。 */
export interface SendMarkdownElement {
  kind: 'markdown';
  markdownContent: string;
  markdownTextSummary?: string;
}

/** 窗口抖动（只有私聊、且必须独占一条消息）。 */
export interface SendPokeElement {
  kind: 'poke';
  subType: number;
}

/**
 * 表情弹射（`commonElem serviceType=23`）—— 会让表情「弹进」聊天窗口的那种。
 *
 * 真机抓包实测（2026-09-25，见 send-schemas 的 {@link EMOJI_BOUNCE_EXTRA}）：
 *
 *   - `faceId` 是小黄脸 id（**不是** tag 3 那个名字，也不是 521xx 收侧那套）；
 *   - `count` 是弹射个数（真机样本 10）；
 *   - `name` 是表情名，**不带斜杠**（`笑哭`，不是 `[笑哭]` / `/笑哭`）。
 *
 * 已真机验证（2026-09-25，6 个 faceId 连发）：PC 协议原样重放能在手机端正常弹射，
 * 内容与真机发的完全一致。验证过的行为：
 *
 *   - `faceId` 换成别的（5 / 66 / 14 / 324 / 183）都正常，**服务端不校验 id**；
 *   - `name` 可以不给（服务端按 faceId 渲染）；
 *   - 越界 id（试过 99999）不报错，服务端**兜底映射成默认表情**；
 *   - `result=0` 只代表服务端收下了，id 是否有效看收端渲染。
 *
 * `count` 的范围（2026-09-26 真机实测，见下）：**QQ 把它当 int32 读**，超过
 * 2^31-1 会按 32 位补码**回绕成负数**再渲染，不报错也不钳制。实测（发出去的
 * 值 → QQ 实际显示）：
 *
 *   2147483647  (2^31-1)         →  2147483647
 *   2147483648  (2^31)           → -2147483648
 *   4294967295  (2^32-1)         → -1
 *   4294967296  (2^32)           →  0
 *   1099511627776 (2^40)         →  0
 *   9007199254740991 (2^53-1)    → -1
 *
 * 即：低 32 位原样保留、按有符号解释，高 32 位被丢弃。`0` 与负数是**静默不弹**
 * （服务端照样 result=0、群序号正常递增），不是错误。
 *
 * ⚠️ **本模块不做范围限制**（`count` 只要求非负安全整数，编码层按 64 位截断后
 * 原样上 wire）—— 上面这套回绕是 **QQ 服务端/收端的行为**，不是我们的。调用方
 * 想发多大就发多大，最终显示成什么由 QQ 决定。
 *
 * pbElem 里那个恒为 13 的 `field1` 与 `detail` 的冗余名字都按真机原样硬编码 ——
 * 语义未知，换别的 faceId 时也照写，实测服务端接受。
 */
export interface SendEmojiBounceElement {
  kind: 'emojiBounce';
  /** 小黄脸 faceId（如 182 = 笑哭）。 */
  faceId: number;
  /**
   * 弹射个数（真机样本 10；0 / 缺省按 1）。
   *
   * 本模块**不限制上限**。注意 QQ 按 int32 读这个字段：超过 2^31-1 会在收端
   * 回绕成负数（`4294967295` 显示成 `-1`、`2^32` 显示成 `0`），详见接口注释。
   */
  count?: number;
  /** 表情名（不带斜杠 / 方括号，如 `笑哭`）；缺省留空，服务端仍会按 faceId 渲染。 */
  name?: string;
}

/**
 * 合并转发卡片（`com.tencent.multimsg` lightApp）。
 *
 * 只负责「引用一个已存在的 resId」这张卡片；真正把内容上传成长消息（拿到 resId）
 * 是独立管线，本包不做。
 */
export interface SendForwardElement {
  kind: 'forward';
  resId: string;
  /** 外层上传时用来跟 actionCommand 对上；缺省随机编一个 UUID。 */
  forwardUuid?: string;
  forwardSource?: string;
  forwardSummary?: string;
  forwardPrompt?: string;
  forwardNews?: { text: string }[];
  forwardTSum?: number;
}

/** 逃生舱：直接给一个 Elem proto 对象（未适配的类型走这里）。 */
export interface SendRawElement {
  kind: 'raw';
  elem: Record<string, unknown>;
}

/**
 * 随消息一起带出的装扮（气泡 / 字体 / 挂件）—— **实验结论：服务端不收，已废弃**。
 *
 * 真机 QQ 客户端确实会把当前装扮显式塞进 PbSendMsg 的 elems（抓包实测：`elem.bubble`
 * tag 9 = 2116371、`elem.generalFlags` tag 37 = { widgetId 104228, font.fontId2 116182 }），
 * 于是照着做了一份同构实现。真机实测（2026-09-25）结论：
 *
 *   1. 请求带装扮 → `result=0` 发得出去，但**服务端落库时把装扮清成 0**
 *      （数据库列 40801 解出来 bubbleId/fontId/widgetId 全 0），服务端不采信客户端
 *      自报的装扮，而是按账号自己当前的装扮记录填。
 *   2. 逐字节重放真机那段 `generalFlags`（连 tag 15/56/71/73/96 全带上）同样是 0 ——
 *      所以不是「我们字段写少了 / 字节序不对」，是服务端只认自己的数据源。
 *   3. 偶发看到某个字体 id「活下来」，是因为那个 id **本来就无效**（换账号重放立刻消失），
 *      不是我们写对了位置。
 *
 * 结论：**这条路走不通，服务端不收客户端指定的装扮**。代码保留（不删）供将来复现实验，
 * 但不要指望它能改变收端看到的装扮 —— 装扮只能靠账号自己的设置。
 *
 * 顺带记下两个已确认的 wire 事实，方便以后查别的：
 *   - 收侧解码时 `font.fontId1`(tag 56) 直接可用；`fontId2`(tag 15) 是字节交换过的
 *     uint16（`((v & 0xff) << 8) | (v >> 8)` 才是真 id）。
 *   - 本实现当初「统一不转、只写 fontId1」，实验已证明这条路救不回来。
 */
export interface SendDress {
  /** 气泡 itemId（0 / 缺省 = 不带）。 */
  bubbleId?: number;
  /**
   * 聊天气泡字体 itemId（0 / 缺省 = 不带）。**真实 itemId**，原样写进
   * `font.fontId1`(tag 56)。
   */
  fontId?: number;
  /**
   * 同一个字体的另一个 wire 槽位（0 / 缺省 = 不带）：`font.fontId2`(tag 15)。
   *
   * 真机在这个槽位写的是**低 16 位字节序交换过**的形态（真实 54981 → wire
   * 116182），收侧 decode 也是按同一规则还原（先看 fontId1，缺失才回退 fontId2
   * 交换）。所以这里同样收**真实 itemId**，打包时自动交换成 tag 15 形态，
   * 调用方不用自己算字节序。字体有两个 id 实现喵。
   */
  fontId2?: number;
  /** 挂件 itemId（0 / 缺省 = 不带）。 */
  widgetId?: number;
}

/** 图片：上传后拼成 `commonElem(serviceType=48, businessType=20)`。 */
export interface SendImageElement {
  kind: 'image';
  /** 本地路径或内存字节。 */
  source: MediaSource;
  /** 收端显示的文件名；缺省 `<md5><扩展名>`。 */
  fileName?: string;
  /** 0 普通图 / 1 动画表情（服务端据此归类）；缺省 0。 */
  subType?: number;
  /** 收端摘要文字；缺省 `[图片]` / `[动画表情]`。 */
  summary?: string;
  width?: number;
  height?: number;
  picFormat?: number;
}

/**
 * 闪照（阅后即焚图）里的老式图片记录 —— 字段编号与收侧 `NOT_ONLINE_IMAGE` 一致，
 * 但只有真机抓包里出现过的那几个（详见 `send-schemas` 的 `FLASH_PHOTO_PIC`）。
 *
 * 抓包（2026-09-27 私聊）实测取值，可作参照：
 *   fileName = 'E4B0B65055D327B993D83E53A00309FD.jpg'（大写 md5 + 扩展名）
 *   fileSize = 102474、md5Hex = 'e4b0b65055d327b993d83e53a00309fd'
 *   downloadPath = resId = '/2863253201-1122281651-E4B0B65055D327B993D83E53A00309FD'
 *   imgType = 1000（jpg）、picHeight = 1920、picWidth = 1437
 *   md5Str = 'BBFCD4CAFC89868FA4501EF1B50E8818'
 */
export interface SendFlashPhotoPic {
  /** 图片文件名（tag 1，老客户端用它显示 / 存盘）。 */
  fileName: string;
  /** 字节数（tag 2）。 */
  fileSize: number;
  /** 图片 MD5（tag 7，写进 wire 的是 16 字节原始摘要）。 */
  md5Hex: string;
  /**
   * 服务端签发的图片路径 `/…-…-<MD5 大写>`（tag 3）。
   *
   * ⚠️ 这一段**不是本地能算出来的**：抓包里是 `/<10 位数字>-<10 位数字>-<MD5 大写>`，
   * 既不是自己 uin 也不是对方 uin，只能从服务端（老图片上传 / 已有图片记录）拿。
   * 缺省留空不上 wire —— 但那样服务端大概率不认这张图。
   */
  downloadPath?: string;
  /** 资源 id（tag 10）；缺省与 {@link downloadPath} 同串（抓包两者一致）。 */
  resId?: string;
  /** 图片格式码（tag 5）：1000 = jpg（抓包值），缺省 1000。 */
  imgType?: number;
  /**
   * tag 8 —— 抓包里装的是**宽**（1920×1437 的图写 1920）。
   * 收侧 `NOT_ONLINE_IMAGE` 把 tag 8 命名成 picHeight，这里保持 wire 语义、名字沿用。
   */
  picHeight?: number;
  /** tag 9 —— 抓包里装的是**高**（同上，写 1437）。 */
  picWidth?: number;
  /** `pbRes.md5Str`(31)：另一份大写 md5（抓包与 NTV2 那套 pbElem 同槽位同值）。 */
  md5Str?: string;
}

/**
 * 闪照：`commonElem(serviceType=3)` + 一条兜底纯文本，**一个元素产出两个 elem**。
 *
 * 与 {@link SendImageElement} 的区别：闪照**不上传**（没有 NTV2 那一步），只是把
 * 一张已经在服务端的老式图片记录按 serviceType=3 重发一遍；也正因为如此，{@link pic}
 * 里的 `downloadPath` / `md5Str` 必须由调用方提供（见 {@link SendFlashPhotoPic}）。
 *
 * QQ 真机会在图片 elem 后面再补一条纯文本 `[闪照]请使用新版手机QQ查看闪照。`，
 * 让不认识 serviceType=3 的老客户端也有东西显示 —— 本实现默认同样补上
 * （{@link FLASH_PHOTO_FALLBACK_TEXT}），可用 `fallbackText` 覆盖。
 */
export interface SendFlashPhotoElement {
  kind: 'flashPhoto';
  /** 老式图片记录。 */
  pic: SendFlashPhotoPic;
  /** 兜底文本；缺省 `[闪照]请使用新版手机QQ查看闪照。`。 */
  fallbackText?: string;
}

/** 闪照的兜底文本（老客户端靠这条认出「这是闪照，去新版看」）。 */
export const FLASH_PHOTO_FALLBACK_TEXT = '[闪照]请使用新版手机QQ查看闪照。';

/** 语音：上传后拼成 `commonElem(serviceType=48, businessType=22)`。 */
export interface SendRecordElement {
  kind: 'record';
  /** SILK 字节（`silk-wasm` encode 产物）或本地路径。 */
  source: MediaSource;
  /** 时长（秒）—— 收端气泡宽度/时长文案看它，写 0 会显示 00:00。 */
  duration?: number;
  /** 波形来源：给 WAV/PCM 出真条，不给则合成一条（只是装饰）。 */
  waveform?: PttWaveformSource;
  voiceFormat?: number;
  fileName?: string;
  /**
   * 变声标记，缺省 `false`（原声）。
   *
   * 真机抓包对比「原声 / 变声」两条群聊语音：变声那条 `extBizInfo.ptt` 多出
   * `changeVoice: 1`（tag 4），且 `bytesReserve` 内嵌的 `{1:0,7:0}` 变成
   * `{1:1,7:0}` —— 两处同步，其余字段完全一致。
   */
  voiceChanged?: boolean;
}

/** 视频：上传后拼成 `commonElem(serviceType=48, businessType=21)`（两个子文件）。 */
export interface SendVideoElement {
  kind: 'video';
  /** 本地路径（流式上传）或内存字节。 */
  source: MediaSource;
  /** 封面；不给则按 width/height 合成一张纯色 PNG。 */
  thumb?: MediaSource;
  duration?: number;
  width?: number;
  height?: number;
  fileName?: string;
  thumbFileName?: string;
}

/**
 * 文件（群文件 / 私聊文件）—— **只在合并转发的节点里有效**。
 *
 * 实时发文件走的是独立管线（`sendGroupFile` / `sendPrivateFile`），不是元素；文件也
 * 不进 `richText.elems`：群聊节点用 `transElem(24)`、私聊节点用 `body.msgContent` 的
 * `FileExtra`。这些编码在 `send-forward.ts` 里做，所以本类型只声明「我要发一个文件」。
 */
export interface SendFileElement {
  kind: 'file';
  /** 本机文件路径（上传按路径流式读，不进内存）。 */
  source: MediaSource;
  /** 收端显示的文件名；缺省用路径 basename。 */
  fileName?: string;
}

/** 需要上传的三种元素。 */
export type SendMediaElement = SendImageElement | SendRecordElement | SendVideoElement;

export type SendElement =
  | SendTextElement
  | SendAtElement
  | SendFaceElement
  | SendMfaceElement
  | SendReplyElement
  | SendArkElement
  | SendXmlElement
  | SendMarkdownElement
  | SendPokeElement
  | SendEmojiBounceElement
  | SendForwardElement
  | SendFileElement
  | SendFlashPhotoElement
  | SendRawElement
  | SendMediaElement;

/** 是否是「要先上传」的元素。 */
export function isSendMediaElement(element: SendElement): element is SendMediaElement {
  return element.kind === 'image' || element.kind === 'record' || element.kind === 'video';
}

/**
 * 上传媒体元素需要的上下文（{@link buildSendElemsWithMedia} / `sendMessage`）。
 *
 * `scene` 决定走群还是私聊的 NTV2 场景 —— 群临时会话与私聊同形（`isGroup: false`
 * + 对方 uid），与 SnowLuma 的 `makeImageElem` 判定一致。
 */
export interface MediaSendContext {
  nt: MediaNative;
  pid: number;
  /** 自己账号的 uin（highway 帧头要带）。 */
  uin: string | number;
  scene: SendScene;
  /** 随消息一起带出的装扮（气泡 / 字体 / 挂件），缺省不带。 */
  dress?: SendDress;
  /** 群号（scene = group 时必填）。 */
  groupId?: number;
  /** 对方 uid（私聊 / 群临时会话必填）。 */
  userUid?: string;
  log?: (message: string) => void;
  /** 每个媒体元素上传完成时回调（用于把「是否走了秒传」透出去）。 */
  onUpload?: (report: SendMediaUploadReport) => void;
}

/**
 * 一个媒体元素的上传结果摘要（只报事实，不含 msgInfo 字节）。
 *
 * `fastUpload` 是**服务端口味的秒传**：响应里没给 uKey = 服务端已按 md5 持有该资源，
 * 所以一个字节都没传，`pbElem` 直接用响应里的 msgInfo。
 */
export interface SendMediaUploadReport {
  kind: 'image' | 'record' | 'video';
  fileName: string;
  fileSize: number;
  md5Hex: string;
  fastUpload: boolean;
}

// ───────────────────────────── helpers ─────────────────────────────

/** xml / ark / forward 卡片的载荷：0x01 标志位 + zlib deflate（与 decode 的 inflate 对应）。 */
export function deflatePayload(content: string): Uint8Array {
  const deflated = deflateSync(Buffer.from(content, 'utf8'));
  const payload = new Uint8Array(deflated.length + 1);
  payload[0] = 0x01;
  payload.set(deflated, 1);
  return payload;
}

/** hex 字符串 → bytes（32 位 hex 的 mface GUID 等）。 */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function requireNonEmpty(value: string | undefined, what: string, kind: string): string {
  const text = value ?? '';
  if (text.length === 0) throw new Error(`${kind} 元素缺少 ${what}`);
  return text;
}

function requirePositiveInt(value: number | undefined, what: string, kind: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`${kind} 元素的 ${what} 必须是正整数，收到 ${String(value)}`);
  }
  return value as number;
}

function requireNonNegativeInt(value: number | undefined, what: string, kind: string): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new Error(`${kind} 元素的 ${what} 必须是非负整数，收到 ${String(value)}`);
  }
  return value as number;
}

// ───────────────────────────── 各元素打包 ─────────────────────────────

/**
 * @ 的 pbReserve 复用收侧的 `TEXT_PB_RESERVE`（tag 布局与发送侧 MentionExtra
 * 一致：3=type、4=uin、5=field5、9=uid），字段名以收侧为准，映射在这里做。
 */
function buildMentionReserve(type: number, uin: number, uid: string): Uint8Array {
  return encode(TEXT_PB_RESERVE, { subType: type, fromUin: uin, atTargetUid: uid });
}

function buildAtElem(element: SendAtElement): Record<string, unknown> {
  const mentionAll = element.all === true || element.atTargetUid === 'all';
  const targetUin = mentionAll ? 0 : (element.atTargetUin ?? 0);
  const targetUid = mentionAll ? 'all' : (element.atTargetUid ?? '');
  if (!mentionAll && targetUin <= 0 && targetUid.length === 0) {
    throw new Error('at 元素需要 atTargetUin（>0）或 atTargetUid（@全体成员用 all: true）');
  }
  if (!mentionAll && targetUin < 0) throw new Error(`at 元素的 atTargetUin 不能为负: ${targetUin}`);

  const fallback = mentionAll ? '@全体成员 ' : targetUin > 0 ? `@${targetUin} ` : `@${targetUid} `;
  const str = element.textContent ?? fallback;

  return {
    text: {
      str,
      pbReserve: buildMentionReserve(mentionAll ? 1 : 2, targetUin, targetUid),
    },
  };
}

function buildFaceElem(element: SendFaceElement): Record<string, unknown> {
  const faceId = requireNonNegativeInt(element.faceId, 'faceId', 'face');
  if (element.superSticker) {
    const sticker = element.superSticker;
    const packId = requireNonEmpty(sticker.packId, 'superSticker.packId', 'face');
    const stickerId = requireNonEmpty(sticker.stickerId, 'superSticker.stickerId', 'face');
    return {
      commonElem: {
        serviceType: 37,
        pbElem: encode(QFACE_EXTRA, {
          packId,
          stickerId,
          qsid: faceId,
          sourceType: sticker.sourceType ?? 1,
          // stickerType（目录 81215 / SnowLuma 的 aniStickerType）：真机抓包里
          // faceId 324 是 1。**不能缺**：少了收端不认 svc37，退化成内联小表情。
          stickerType: sticker.stickerType ?? 1,
          // QQ 显式写空的 resultId（`32 00`）；schema 里这个字段是 force 的。
          resultId: '',
          // QFaceExtra.text：抓包实测 QQ 会带上表情外显文字（324 → "/吃糖"），
          // 缺了收端可能不把它当大贴纸渲染。
          text: sticker.text ?? element.faceText,
          randomType: sticker.randomType ?? 1,
        }),
        businessType: 1,
      },
    };
  }
  if (element.smallFace) {
    // 真机抓包（2026-09-27）对齐：QQ 的 QSmallFaceExtra 一定带 preview/preview2
    // （表情外显文字，如 faceId 324 → "/吃糖"），旧实现只写 faceId。
    const preview = element.faceText ?? '';
    return {
      commonElem: {
        serviceType: 33,
        pbElem: encode(QSMALL_FACE_EXTRA, { faceId, preview, preview2: preview }),
        businessType: 1,
      },
    };
  }
  // 老 wire 直出的经典表情：index 就是 faceId（im_msg_body.proto message Face）。
  return { face: { index: faceId } };
}

function buildMfaceElem(element: SendMfaceElement): Record<string, unknown> {
  const raw = element.marketEmoticonId;
  let guid: Uint8Array;
  if (typeof raw === 'string') {
    if (!/^[0-9a-fA-F]{32}$/.test(raw)) {
      throw new Error(`mface 元素的 marketEmoticonId 必须是 32 位 hex，收到 "${raw}"`);
    }
    guid = hexToBytes(raw);
  } else if (raw instanceof Uint8Array) {
    guid = raw;
  } else {
    throw new Error('mface 元素的 marketEmoticonId 必须是 Uint8Array 或 32 位 hex 字符串');
  }
  if (guid.length !== 16) {
    throw new Error(`mface 元素的 marketEmoticonId 必须是 16 字节，收到 ${guid.length} 字节`);
  }
  const emojiPackId = element.emojiPackId ?? 0;
  if (!Number.isSafeInteger(emojiPackId) || emojiPackId < 0) {
    throw new Error(`mface 元素的 emojiPackId 必须是非负整数，收到 ${String(element.emojiPackId)}`);
  }

  // 常量（itemType=6 / faceInfo=1 / subType=3 / pbReserve.animated=1）与 SnowLuma
  // `makeMarketFaceElem`、NapCat `PacketMsgMarkFaceElement.buildElement` 一致：
  // 服务端靠这几个值把它当成商城贴纸转发。
  //
  // 真机抓包（2026-09-27）对齐：previewWidth/Height=200（旧实现写 300）、pbReserve
  // 是一段带 300/200 两套尺寸对的 44 字节结构（旧实现只写 field8=1）。
  return {
    marketFace: {
      faceName: element.faceName ?? '',
      itemType: 6,
      faceInfo: 1,
      marketEmoticonId: guid,
      emojiPackId,
      subType: element.subType ?? 3,
      encryptKey: element.encryptKey ?? '',
      // QQ 显式写 0（schema 里 force），保持逐字节一致。
      mediaType: 0,
      previewWidth: element.previewWidth ?? 200,
      previewHeight: element.previewHeight ?? 200,
      pbReserve: encode(MARKET_FACE_PB_RESERVE, {
        previewSizes: [
          { width: 300, height: 300 },
          { width: 200, height: 200 },
        ],
        // 真机这几个槽位是显式 0（schema 里 force），别删；field5 是 LEN 型空值。
        field2: 0,
        field5: new Uint8Array(0),
        field6: 0,
        field7: 0,
        animated: 1,
        originalSizes: [
          { width: 300, height: 300 },
          { width: 200, height: 200 },
        ],
        field10: 0,
      }),
    },
  };
}

/**
 * 表情弹射 → `commonElem { serviceType: 23 }`。
 *
 * pbElem 的字段布局照真机抓包硬编码（见 send-schemas 的 EMOJI_BOUNCE_EXTRA）：
 * `field1` 恒 13、`count` = 弹射个数、`name` = 表情名（不带斜杠）、
 * `detail{faceId, name, name2}` 冗余一份。真机样本是 faceId=182(笑哭)/count=10/
 * name='笑哭'，重放后手机端正常弹射。
 */
function buildEmojiBounceElem(element: SendEmojiBounceElement): Record<string, unknown> {
  const faceId = requireNonNegativeInt(element.faceId, 'faceId', 'emojiBounce');
  // 真机样本没有「数量 0」这种形态；缺省按 1（弹一个），与 poke 的宽松度一致。
  const count =
    element.count === undefined ? 1 : requireNonNegativeInt(element.count, 'count', 'emojiBounce');
  // 名字缺省留空：服务端/收端都按 faceId 渲染，名字只是给人看的冗余。
  const name = element.name ?? '';
  return {
    commonElem: {
      serviceType: 23,
      pbElem: encode(EMOJI_BOUNCE_EXTRA, {
        field1: 13,
        count,
        name,
        detail: { faceId, name, name2: name },
      }),
      businessType: 13,
    },
  };
}

function buildReplyElem(element: SendReplyElement): Record<string, unknown> {
  const seq = requirePositiveInt(element.origMsgSeq, 'origMsgSeq', 'reply');
  const outgoing: Record<string, unknown> = { origMsgSeq: [seq] };
  if (element.origSenderUin !== undefined) outgoing.origSenderUin = element.origSenderUin;
  if (element.origMsgTime !== undefined) outgoing.origMsgTime = element.origMsgTime;
  if (element.origElementsRaw !== undefined && element.origElementsRaw.length > 0) {
    outgoing.origElementsRaw = element.origElementsRaw;
  } else if (element.origElements !== undefined && element.origElements.length > 0) {
    outgoing.origElementsRaw = element.origElements.map((quoted) =>
      encode(ELEM, buildSendElem(quoted)),
    );
  }
  return { replyElement: outgoing };
}

function buildForwardElem(element: SendForwardElement): Record<string, unknown> {
  const resId = requireNonEmpty(element.resId, 'resId', 'forward');
  // uniseq 必须在外层上传的 piggyback actionCommand 里对得上，嵌套转发才不会多打
  // 一次服务器；没有就现编一个（平铺转发用不上，编一个也无害）。
  const uniseq = (element.forwardUuid ?? '').trim() || randomUUID();
  const news = element.forwardNews ?? [];
  const source = element.forwardSource?.length ? element.forwardSource : '聊天记录';
  const summary = element.forwardSummary?.length ? element.forwardSummary : '查看转发消息';
  const prompt = element.forwardPrompt?.length ? element.forwardPrompt : '[聊天记录]';
  const tSum =
    element.forwardTSum && element.forwardTSum > 0 ? element.forwardTSum : Math.max(news.length, 1);

  // 键顺序照抄 SnowLuma/NapCat 的 lightApp（QQ 端按 json 文本比对，别乱排）。
  const lightApp = {
    app: 'com.tencent.multimsg',
    config: {
      autosize: 1,
      forward: 1,
      round: 1,
      type: 'normal',
      width: 300,
    },
    desc: prompt,
    extra: JSON.stringify({ filename: uniseq, tsum: tSum }),
    meta: {
      detail: {
        news: news.map((n) => ({ text: n.text ?? '' })),
        resid: resId,
        source,
        summary,
        uniseq,
      },
    },
    prompt,
    ver: '0.0.0.5',
    view: 'contact',
  };

  return { lightApp: { data: deflatePayload(JSON.stringify(lightApp)) } };
}

/** 单个元素 → Elem proto 对象。 */
function buildSendElem(element: SendElement): Record<string, unknown> {
  switch (element.kind) {
    case 'flashPhoto':
      // 闪照是 1 → 2（图片 elem + 兜底文本 elem），走 buildSendElemList。
      throw new Error(
        'flashPhoto 元素产出两个 elem：请用 buildSendElems() / buildSendElemsWithMedia()（本函数只处理一对一元素）',
      );
    case 'image':
    case 'record':
    case 'video':
      // 媒体元素必须先上传（拿到 msgInfo）才能拼 commonElem。
      throw new Error(
        `${element.kind} 元素需要先上传：请用 buildSendElemsWithMedia()，或给 sendMessage 传 media 上下文`,
      );
    case 'file':
      // 文件不进 richText.elems：实时发送走 sendGroupFile / sendPrivateFile，
      // 合并转发里由 send-forward.ts 编码成 transElem(24) / msgContent。
      throw new Error(
        'file 元素不能作为普通消息元素发送：实时发文件请用 sendGroupFile / sendPrivateFile，放进聊天记录请用 sendForward',
      );
    case 'text': {
      const str = requireNonEmpty(element.textContent, 'textContent', 'text');
      return { text: { str } };
    }
    case 'at':
      return buildAtElem(element);
    case 'face':
      return buildFaceElem(element);
    case 'mface':
      return buildMfaceElem(element);
    case 'reply':
      return buildReplyElem(element);
    case 'ark':
      return {
        lightApp: { data: deflatePayload(requireNonEmpty(element.arkData, 'arkData', 'ark')) },
      };
    case 'xml':
      return {
        richMsg: {
          // subType 0 与缺省都按 35（一般 XML 卡片）走。
          serviceId: element.subType ? element.subType : 35,
          template1: deflatePayload(requireNonEmpty(element.xmlContent, 'xmlContent', 'xml')),
        },
      };
    case 'markdown':
      return {
        commonElem: {
          serviceType: 45,
          // 复用收侧的 MARKDOWN_COMMON_PB（1=正文、5=摘要），字段名以收侧为准。
          pbElem: encode(MARKDOWN_COMMON_PB, {
            markdownContent: requireNonEmpty(
              element.markdownContent,
              'markdownContent',
              'markdown',
            ),
            markdownTextSummary: element.markdownTextSummary,
          }),
          businessType: 1,
        },
      };
    case 'poke': {
      const type = requireNonNegativeInt(element.subType, 'subType', 'poke');
      return {
        commonElem: {
          serviceType: 2,
          pbElem: encode(POKE_EXTRA, { type }),
          businessType: type,
        },
      };
    }
    case 'emojiBounce':
      return buildEmojiBounceElem(element);
    case 'forward':
      return buildForwardElem(element);
    case 'raw':
      if (!element.elem || typeof element.elem !== 'object') {
        throw new Error('raw 元素的 elem 必须是一个 Elem proto 对象');
      }
      return element.elem;
    default: {
      const unknown = element as { kind?: unknown };
      throw new Error(`不支持发送的元素类型: ${String(unknown.kind)}`);
    }
  }
}

/**
 * 闪照 → 两个 elem：`commonElem(serviceType=3)` + 一条兜底纯文本（QQ 真机就是这么发的）。
 *
 * pbElem 只有一层包装（field 2 = 老式 NotOnlineImage），字段与抓包逐字节对齐：
 * 两个显式 0 骨架（`original` 与 `pbRes`）由 `send-schemas` 里的 force 负责。
 */
function buildFlashPhotoElems(element: SendFlashPhotoElement): Record<string, unknown>[] {
  const pic = element.pic as SendFlashPhotoPic | undefined;
  if (pic == null || typeof pic !== 'object') {
    throw new Error('flashPhoto 元素缺少 pic（老式图片记录）');
  }
  const fileName = requireNonEmpty(pic.fileName, 'pic.fileName', 'flashPhoto');
  const fileSize = requirePositiveInt(pic.fileSize, 'pic.fileSize', 'flashPhoto');
  const md5Hex = (pic.md5Hex ?? '').trim();
  if (!/^[0-9a-fA-F]{32}$/.test(md5Hex)) {
    throw new Error(`flashPhoto 的 pic.md5Hex 必须是 32 位 hex，收到 "${String(pic.md5Hex)}"`);
  }
  for (const [name, value] of [
    ['picHeight', pic.picHeight],
    ['picWidth', pic.picWidth],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`flashPhoto 的 pic.${name} 必须是非负整数，收到 ${String(value)}`);
    }
  }
  const downloadPath = pic.downloadPath ?? '';
  const pbElem = encode(FLASH_PHOTO_PB, {
    pic: {
      filePath: fileName,
      fileLen: fileSize,
      downloadPath,
      imgType: pic.imgType ?? 1000,
      picMd5: hexToBytes(md5Hex),
      picHeight: pic.picHeight ?? 0,
      picWidth: pic.picWidth ?? 0,
      // 抓包里 resId 与 downloadPath 是同一串；只给其中一个也能发。
      resId: pic.resId ?? downloadPath,
      original: 0,
      pbRes: {
        subType: 0,
        field3: 0,
        field4: 0,
        field10: 0,
        // 这一段是显式零值骨架（force 在 schema 上），少了字节就对不上抓包。
        field20: { field1: 0, field2: '', field3: 0, field4: 0, field5: 0, field7: '' },
        md5Str: pic.md5Str ?? '',
      },
    },
  });
  return [
    { commonElem: { serviceType: FLASH_PHOTO_SERVICE_TYPE, pbElem } },
    { text: { str: element.fallbackText ?? FLASH_PHOTO_FALLBACK_TEXT } },
  ];
}

/**
 * 单个元素 → 一组 Elem proto 对象。
 *
 * 绝大多数元素是一对一；闪照是唯一的一对多（图片 + 兜底文本），所以打包入口都走
 * 这里而不是直接 {@link buildSendElem}。
 */
function buildSendElemList(element: SendElement): Record<string, unknown>[] {
  if (element.kind === 'flashPhoto') return buildFlashPhotoElems(element);
  return [buildSendElem(element)];
}

/** 场景限制校验（窗口抖动只能私聊、且必须独占一条消息）。 */
function assertScenePolicy(elements: readonly SendElement[], scene: SendScene | undefined): void {
  const pokeCount = elements.filter((e) => e.kind === 'poke').length;
  if (pokeCount === 0) return;
  if (scene !== undefined && scene !== 'c2c') {
    throw new Error('poke（窗口抖动）只能在直接私聊里发送');
  }
  if (pokeCount !== 1 || elements.length !== 1) {
    throw new Error('poke（窗口抖动）必须独占一条消息');
  }
}

/**
 * 装扮 id 校验：缺省 / 0 视为「不带」，其余必须是非负安全整数。
 * 负数的成因基本是调用方拿错了值（比如把 -1 当成「用默认款」），所以直接报错。
 */
function normalizeDressId(value: number | undefined, what: string): number {
  if (value === undefined || value === 0) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dress.${what} 必须是非负整数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 真实字体 itemId → `fontId2`(tag 15) 的 wire 形态：低 16 位字节序交换。
 *
 * 与收侧 {@link decodeMessage} 的回退规则互为逆运算（那里 `((v & 0xff) << 8) |
 * (v >> 8)`），真机抓包也是这个形态。汉字字体 / 普通字体共用同一套换算。
 *
 * 注：真机那次抓包 tag 15 的原始值是 `116182`（= `0x1C5D6`），比本函数算出的
 * `0xC5D6` 多一个 bit 16；收侧解码会把这个高位掩掉，两者都还原成 `54981`。
 * 那个高位语义未知，这里按「与解码严格互逆」写。
 */
export function swapFontId16(itemId: number): number {
  return ((itemId & 0xff) << 8) | ((itemId >>> 8) & 0xff);
}

/**
 * 装扮 → **前置**的装扮 elems（真机抓包里它们排在正文元素之前）。
 *
 * 一个 `generalFlags` 同时承载字体与挂件（真机就是这么合的），气泡单独一个 elem；
 * 三项都缺省 / 为 0 时返回空数组，一个字节都不多写 —— 不传 `dress` 就不会改变
 * 现有消息的字节（回归面为零）。
 */
export function buildDressElems(dress: SendDress | undefined): Record<string, unknown>[] {
  if (!dress) return [];
  const out: Record<string, unknown>[] = [];

  const widgetId = normalizeDressId(dress.widgetId, 'widgetId');
  const fontId = normalizeDressId(dress.fontId, 'fontId');
  const fontId2 = normalizeDressId(dress.fontId2, 'fontId2');
  if (widgetId > 0 || fontId > 0 || fontId2 > 0) {
    const generalFlags: Record<string, unknown> = {};
    if (widgetId > 0) generalFlags.widgetId = widgetId;
    // 字体两个槽位都按「调用方给真实 itemId」的约定写：fontId1 原样、fontId2 交换。
    // 只给其中一个也能发（老客户端各认一个槽位），两个都给时收侧优先 fontId1。
    if (fontId > 0 || fontId2 > 0) {
      const font: Record<string, unknown> = {};
      if (fontId > 0) font.fontId1 = fontId;
      if (fontId2 > 0) font.fontId2 = swapFontId16(fontId2);
      generalFlags.font = font;
    }
    out.push({ generalFlags });
  }

  const bubbleId = normalizeDressId(dress.bubbleId, 'bubbleId');
  if (bubbleId > 0) out.push({ bubble: { id: bubbleId } });

  return out;
}

/**
 * 元素数组 → Elem proto 对象数组（同步，媒体元素会报错）。
 *
 * 全部校验都在**任何副作用之前**完成（媒体上传的版本会先把整条消息校验一遍），
 * 免得前半条已经产生副作用、后半条才报错。
 *
 * `options.dress` 给了就把装扮 elems 前置到元素数组最前面（与真机顺序一致）。
 */
export function buildSendElems(
  elements: readonly SendElement[],
  options: { scene?: SendScene; dress?: SendDress } = {},
): Record<string, unknown>[] {
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error('消息不能为空');
  }
  assertScenePolicy(elements, options.scene);
  // 装扮先校验、先打包：坏 id 要在打包任何元素之前就报错。
  const dressElems = buildDressElems(options.dress);
  return [...dressElems, ...elements.flatMap((element) => buildSendElemList(element))];
}

// ───────────────────────── 媒体元素（先上传再打包） ─────────────────────────

/** 媒体元素的入参校验（在联网之前跑完）。 */
function assertMediaElement(element: SendMediaElement): void {
  const source = element.source;
  const validSource =
    (typeof source === 'string' && source.trim().length > 0) ||
    (source instanceof Uint8Array && source.length > 0);
  if (!validSource) {
    throw new Error(`${element.kind} 元素的 source 必须是非空路径或 Uint8Array`);
  }
  if (element.kind === 'record' && element.duration !== undefined) {
    // 允许小数（录音时长天然不是整秒，如 1.4s）—— 上 wire 时按秒四舍五入
    // （`highway/media-upload` 的 `fileInfo.time`），这里只拦负数 / NaN。
    if (!Number.isFinite(element.duration) || element.duration < 0) {
      throw new Error(`record 元素的 duration 必须是非负秒数，收到 ${String(element.duration)}`);
    }
  }
  if (element.kind === 'record' && element.voiceChanged !== undefined) {
    if (typeof element.voiceChanged !== 'boolean') {
      throw new Error(
        `record 元素的 voiceChanged 必须是布尔值，收到 ${String(element.voiceChanged)}`,
      );
    }
  }
  if (element.kind === 'video') {
    for (const [name, value] of [
      ['width', element.width],
      ['height', element.height],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`video 元素的 ${name} 必须是非负整数，收到 ${String(value)}`);
      }
    }
  }
}

/** 上传目标解析（群用群号；私聊/群临时会话用对方 uid）。 */
function resolveMediaTarget(ctx: MediaSendContext): MediaUploadTarget {
  if (ctx.scene === 'group') {
    if (!Number.isSafeInteger(ctx.groupId) || (ctx.groupId ?? 0) <= 0) {
      throw new Error('群聊媒体消息需要 ctx.groupId（群号）');
    }
    return { uin: ctx.uin, isGroup: true, groupId: ctx.groupId };
  }
  if (!ctx.userUid?.trim()) {
    const scene = ctx.scene === 'c2c' ? '私聊' : '群临时会话';
    throw new Error(`${scene}媒体消息需要 ctx.userUid（NTV2 上传与路由都要求 uid）`);
  }
  return { uin: ctx.uin, isGroup: false, userUid: ctx.userUid };
}

/**
 * 上传结果 → Elem proto 对象。
 *
 * `businessType` 不再在这里按 kind 猜：上传方知道场景（群 / 私聊），而两边的取值以后可能不同
 * （目前语音两边都是 22，见 `RICH_MEDIA_BUSINESS_TYPE.voice`）。
 */
function buildMediaElem(upload: MediaUploadResult): Record<string, unknown> {
  return {
    commonElem: {
      serviceType: RICH_MEDIA_SERVICE_TYPE,
      pbElem: upload.msgInfo,
      businessType: upload.businessType,
    },
  };
}

// 注：实验 B（私聊语音 businessType 12）真机验证无效，已回滚为群/私聊同为 22 ——
// 见 `RICH_MEDIA_BUSINESS_TYPE.voice`。私聊画不出波形的真凶在 `bytesGeneralFlags`
// （见 `highway/media-upload.ts` 的 `uploadPttMsgInfo`），与这个值无关。

/**
 * 元素数组 → Elem proto 对象数组（**含媒体上传**）。
 *
 * 顺序：先把整条消息校验完（非媒体元素当场打包，媒体元素只做入参校验），再逐个
 * 上传媒体，最后按原顺序拼好 —— 任何校验失败都发生在第一次联网之前。
 * 上传是串行的（一条消息里的媒体数量通常就是 1~2 个，串行更好定位失败原因）。
 */
export async function buildSendElemsWithMedia(
  elements: readonly SendElement[],
  ctx: MediaSendContext,
): Promise<Record<string, unknown>[]> {
  if (!Array.isArray(elements) || elements.length === 0) throw new Error('消息不能为空');
  assertScenePolicy(elements, ctx.scene);

  // 装扮与媒体无关，但顺序要和同步版本一致（装扮在最前）——先校验、先打包。
  const dressElems = buildDressElems(ctx.dress);

  const hasMedia = elements.some((element) => isSendMediaElement(element));
  if (!hasMedia) {
    return [...dressElems, ...elements.flatMap((element) => buildSendElemList(element))];
  }

  // 每个槽位是一组 elem：媒体元素上传后才填，闪照这种一对多元素直接占满自己的槽位。
  const slots: (Record<string, unknown>[] | null)[] = [];
  for (const element of elements) {
    if (isSendMediaElement(element)) {
      assertMediaElement(element);
      slots.push(null);
    } else {
      slots.push(buildSendElemList(element));
    }
  }

  const target = resolveMediaTarget(ctx);
  const options = ctx.log ? { log: ctx.log } : {};
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]!;
    if (!isSendMediaElement(element)) continue;
    const upload =
      element.kind === 'image'
        ? await uploadImageMsgInfo(ctx.nt, ctx.pid, target, element, options)
        : element.kind === 'record'
          ? await uploadPttMsgInfo(ctx.nt, ctx.pid, target, element, options)
          : await uploadVideoMsgInfo(ctx.nt, ctx.pid, target, element, options);
    slots[index] = [buildMediaElem(upload)];
    ctx.onUpload?.({
      kind: element.kind,
      fileName: upload.fileName,
      fileSize: upload.fileSize,
      md5Hex: upload.md5Hex,
      fastUpload: upload.fastUpload,
    });
  }

  return [...dressElems, ...slots.flatMap((value) => value as Record<string, unknown>[])];
}
