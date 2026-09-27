// OIDB 0x929b_0 —— AI 声聊（TTS）语音生成。
//
// 把「文字 + 声线 id」交给服务端合成语音，回包带音频文件索引（md5 / sha1 / 文件名 /
// 大小 / 下载票据）。纯生成接口：**它不发送消息**，后续要发还得走 MessageSvc.PbSendMsg。
//
// ⚠️ **只支持群聊。** 目标字段是 groupCode（群号，varint），换成私聊 uin/uid 服务端不认。
//
// 字段布局由真机抓包 + 服务端错误回显反推（失败时服务端会把解好的请求 dump 出来，
// 直接给出字段名：group_code / voice_id / text / chat_type / client_msg_info）：
//
//   inner req:
//     f1 groupCode     uint64   群号
//     f2 voiceId       string   声线 id（如 lucy-voice-suxinjiejie）
//     f3 text          string   要合成的文字
//     f4 chatType      uint32   1 = 群聊；2 = 服务端识别为 C2C（见下）
//     f5 clientMsgInfo { f1 msgRandom uint32 }
//
//   inner resp:
//     f1 retCode       uint32   实测成功恒为 1
//     f3 field3        uint32   实测恒为 20
//     f4 audio         { f1 data { f1 node { … } }  f2 sender { … } }
//
// **私聊实测（2026-09-26，真机）**：把 f1 换成私聊目标一律失败 ——
//   - f1 = uid 字符串 u_LKt3AdAIMP-CUfn6ydzDzw：回显里 f1 变成**未知字段** 1:"u_…"，
//     即它只把 f1 当 varint 读，字符串不进 schema。
//   - f1 = 目标 uin 2863253201：被读成 group_code:2863253201，当群号查，查不到会话。
//   - chatType=2 能过结构校验但报 70001 AudioRsp MediaData is Empty；chatType=1 + 非群
//     目标报 31001 GenerateAudio err；chatType=3 也退回 31001（枚举校验）。
//
// 所以对端 uid **不在** f1 这个位置 —— 想走私聊得先找到真正的对端字段，别硬塞 f1。
//
// **声线目录（另一条 OIDB）**：客户端的声线列表走 `OidbSvcTrpcTcp.0x929d_0`，
// 响应 repeated 分组（推荐 / 搞怪 / 古风 / 现代），每条 item = { voiceId, 中文名,
// 样音 URL }。2026-09-26 实测 4 组 / 30 条、去重 22 个 voiceId（同一条声线会
// 出现在多个分组）。**本文件只实现 0x929b_0 合成**，目录没有走协议、由前端硬编码。
//
// 试听样音是 res.qpt.qq.com 上的静态对象，无签名、不需要在线实例：
//   https://res.qpt.qq.com/qpilot/tts_sample/group/<样音文件名>.wav
// ⚠️ 样音文件名**通常**等于 voiceId，但**不保证** —— `lucy-voice-lizeyan`
// （霸道总裁）的样音是 `lucy-voice-lizeyan-2.wav`。要试听请用目录给的 URL，
// 别拿 voiceId 硬拼。完整清单 / 分组 / 字段布局见 docs/develop/ai-voice.md。
// 我们**不**把样音入库。

import { message } from '../protobuf';
import type { OidbNative } from '../transport';
import { invokeOidb, type OidbSpec } from './invoke';
import { toInt } from './shared';

// ───────────────────────────── 请求 ─────────────────────────────

/** client_msg_info（f5）：目前只观察到 msg_random。 */
const CLIENT_MSG_INFO = message([{ name: 'msgRandom', tag: 1, type: 'uint32' }]);

const AI_VOICE_REQ = message([
  { name: 'groupCode', tag: 1, type: 'uint64' },
  { name: 'voiceId', tag: 2, type: 'string' },
  { name: 'text', tag: 3, type: 'string' },
  { name: 'chatType', tag: 4, type: 'uint32' },
  { name: 'clientMsgInfo', tag: 5, type: CLIENT_MSG_INFO },
]);

// ───────────────────────────── 响应 ─────────────────────────────

/**
 * file_type（node.fileInfo.f5）。与 NTV2 的 NTV2_FILE_TYPE 同构：
 * 实测语音是 { type: 3, voiceFormat: 1 }（3 = 语音，1 = AMR）。
 */
const FILE_TYPE = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'picFormat', tag: 2, type: 'uint32' },
  { name: 'videoFormat', tag: 3, type: 'uint32' },
  { name: 'voiceFormat', tag: 4, type: 'uint32' },
]);

/** 合成结果的音频文件索引（tag 布局与 NTV2 的 NTV2_FILE_INFO 一致）。 */
const FILE_INFO = message([
  { name: 'fileSize', tag: 1, type: 'uint32' },
  { name: 'fileHash', tag: 2, type: 'string' },
  { name: 'fileSha1', tag: 3, type: 'string' },
  { name: 'fileName', tag: 4, type: 'string' },
  { name: 'type', tag: 5, type: FILE_TYPE },
  { name: 'width', tag: 6, type: 'uint32' },
  { name: 'height', tag: 7, type: 'uint32' },
  { name: 'time', tag: 8, type: 'uint32' },
  { name: 'original', tag: 9, type: 'uint32' },
]);

/**
 * 音频节点。字段 1/3/4/5 与 NTV2_INDEX_NODE 的 info/storeId/uploadTime/ttl 同位，
 * 但 f2 实测是一段约 99 字符的 base64 **下载票据**（再解一层是 protobuf：含 sha1、
 * fileId、环境 prod、ttl、md5、"gz"），不是 NTV2 那种 fileUuid，故单独命名。
 */
const AUDIO_NODE = message([
  { name: 'fileInfo', tag: 1, type: FILE_INFO },
  { name: 'urlParam', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'uploadTime', tag: 4, type: 'uint32' },
  { name: 'ttlSeconds', tag: 5, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'uint32' },
]);

/** audio.data（f4.f1）：目前只看到一层 node 包装。 */
const AUDIO_DATA = message([{ name: 'node', tag: 1, type: AUDIO_NODE }]);

/**
 * audio.sender（f4.f2）：生成者信息。f5/f12 内部结构随调用变化（f5.field1 实测
 * 出现 7/10/13/… 等值），保留为字段号直译，不做语义猜测。
 */
const SENDER_FIELD5 = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'bytes' },
]);

const SENDER_FIELD12 = message([{ name: 'field9', tag: 9, type: 'uint32' }]);

const SENDER_FIELD3 = message([
  { name: 'uin', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'field5', tag: 5, type: SENDER_FIELD5 },
  { name: 'field12', tag: 12, type: SENDER_FIELD12 },
]);

const AUDIO_SENDER = message([
  { name: 'field3', tag: 3, type: SENDER_FIELD3 },
  { name: 'field10', tag: 10, type: 'uint32' },
]);

/** audio（f4）。 */
const AUDIO = message([
  { name: 'data', tag: 1, type: AUDIO_DATA },
  { name: 'sender', tag: 2, type: AUDIO_SENDER },
]);

const AI_VOICE_RESP = message([
  { name: 'retCode', tag: 1, type: 'uint32' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'audio', tag: 4, type: AUDIO },
]);

// ───────────────────────────── 类型 ─────────────────────────────

export interface SendAiVoiceParams {
  /**
   * 目标**群号**。
   *
   * 只收群号：填私聊 uin 会被服务端当群号查（查不到），填 uid 字符串则整条字段
   * 退化成未知字段 —— 私聊不支持，见文件头注释。
   */
  groupCode: number;
  /** 声线 id，例如 lucy-voice-suxinjiejie（服务端按 id 查声线，不存在则报错）。 */
  voiceId: string;
  /** 要合成的文字。 */
  text: string;
  /** 合成场景。1 = 群聊（默认）。2 服务端认，但当前只会得到 70001。 */
  chatType?: 1 | 2;
  /** 客户端随机数（回执/去重）。缺省随机生成。 */
  msgRandom?: number;
}

/** 合成出的音频文件索引。 */
export interface AiVoiceFileInfo {
  /** 字节数。 */
  fileSize: number;
  /** 文件 md5（32 位 hex）。 */
  fileHash: string;
  /** 文件 sha1（40 位 hex）。 */
  fileSha1: string;
  /** 文件名，实测形如 <md5>.amr。 */
  fileName: string;
  /** 文件类型；实测语音为 type=3, voiceFormat=1。 */
  type: { type: number; picFormat: number; videoFormat: number; voiceFormat: number };
  /** 是否原图（保留字段，语音场景实测为 1）。 */
  original: number;
}

export interface SendAiVoiceResult {
  /** 内层返回码，实测成功恒为 1。 */
  retCode: number;
  /** 实测恒为 20（未知语义）。 */
  field3: number;
  /** 合成结果；服务端拒绝时该接口直接抛错（OIDB errorCode != 0），这里只在成功时出现。 */
  audio?: {
    /** 音频文件索引（fileInfo）+ 下载票据（urlParam）。 */
    node: {
      fileInfo: AiVoiceFileInfo;
      /**
       * 约 99 字符的 base64（URL-safe）**下载票据**。再解一层 protobuf，
       * 含 sha1 / fileId / 环境 / ttl / md5 / "gz"。合成下载 URL 还需要
       * NTV2 的 domain，本模块不拼，原样给出。
       */
      urlParam: string;
      field3: number;
      uploadTime: number;
      /** 票据有效期（秒），实测 604800 = 7 天。 */
      ttlSeconds: number;
      /** 实测 1403（未知语义）。 */
      field7: number;
    } | null;
    /** 生成者 uin。 */
    senderUin: number | null;
  };
}

// ───────────────────────────── spec ─────────────────────────────

export namespace SendAiVoice {
  /** SSO 命令 OidbSvcTrpcTcp.0x929b_0。 */
  export const command = 0x929b;
  export const subCommand = 0;
  export const reqSchema = AI_VOICE_REQ;
  export const respSchema = AI_VOICE_RESP;

  /** 成功判定：内层 retCode === 1（实测成功值）。 */
  export const isOk = (result: SendAiVoiceResult): boolean => result.retCode === 1;

  export const serialize = (p: SendAiVoiceParams): Record<string, unknown> => ({
    groupCode: p.groupCode,
    voiceId: p.voiceId,
    text: p.text,
    chatType: p.chatType ?? 1,
    clientMsgInfo: { msgRandom: p.msgRandom ?? Math.floor(Math.random() * 0x7fffffff) },
  });

  export const deserialize = (body: Record<string, unknown>): SendAiVoiceResult => {
    const audio = (body.audio ?? {}) as Record<string, unknown>;
    const node = ((audio.data as Record<string, unknown> | undefined)?.node ?? {}) as Record<
      string,
      unknown
    >;
    const info = (node.fileInfo ?? {}) as Record<string, unknown>;
    const type = (info.type ?? {}) as Record<string, unknown>;
    const sender = ((audio.sender as Record<string, unknown> | undefined)?.field3 ?? {}) as Record<
      string,
      unknown
    >;
    const hasNode = Object.keys(info).length > 0;
    return {
      retCode: toInt(body.retCode),
      field3: toInt(body.field3),
      audio: {
        node: hasNode
          ? {
              fileInfo: {
                fileSize: toInt(info.fileSize),
                fileHash: typeof info.fileHash === 'string' ? info.fileHash : '',
                fileSha1: typeof info.fileSha1 === 'string' ? info.fileSha1 : '',
                fileName: typeof info.fileName === 'string' ? info.fileName : '',
                type: {
                  type: toInt(type.type),
                  picFormat: toInt(type.picFormat),
                  videoFormat: toInt(type.videoFormat),
                  voiceFormat: toInt(type.voiceFormat),
                },
                original: toInt(info.original),
              },
              urlParam: typeof node.urlParam === 'string' ? node.urlParam : '',
              field3: toInt(node.field3),
              uploadTime: toInt(node.uploadTime),
              ttlSeconds: toInt(node.ttlSeconds),
              field7: toInt(node.field7),
            }
          : null,
        senderUin: sender.uin === undefined ? null : toInt(sender.uin),
      },
    };
  };

  /**
   * 生成一条 AI 声聊语音。**群聊专用**（params.groupCode）。
   *
   * 服务端拒绝时抛错（native 把 OIDB errorCode 抛成异常），错误文案里带原始请求 dump，
   * 例如 31001 (GenerateAudio err) / 70001 (AudioRsp MediaData is Empty, req:…)。
   */
  export const invoke = (
    nt: OidbNative,
    pid: number,
    params: SendAiVoiceParams,
  ): Promise<SendAiVoiceResult> =>
    invokeOidb(nt, pid, SendAiVoice as OidbSpec<SendAiVoiceParams, SendAiVoiceResult>, params);
}
