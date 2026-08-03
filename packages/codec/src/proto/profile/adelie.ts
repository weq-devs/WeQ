/**
 * `profile_info_adelie` 的 BLOB 列 —— QQ 机器人（官方叫 "adelie"）的档案。
 *
 * 这张表只有查看过机器人资料卡才会写入，所以**不能**拿它判断某个 uid 是不是
 * 机器人 —— 判据在 `21000.ts` 的 `BotMarkWire`。这里只负责把已缓存的机器人
 * 档案解出来。
 *
 * 标量列（不在本文件）：
 *   1000   uid
 *   1002   uin
 *   320001 昵称
 *   320002 头像 URL
 *   320003 简介
 *   320004 欢迎语
 *   320007 唤醒指令（如 "@QQ"）
 *   320008 AIO 聊天背景图（亮色）      —— 与 320065.lightBgUrl 恒等
 *   320009 AIO 聊天背景图（暗色）      —— 与 320065.darkBgUrl 恒等
 *   320068 主题色（"#1E74FF"）
 *
 * 每列都是各自独立的 protobuf 报文，且**自带列号做外层 tag**（跟 21000 一样）。
 */

import { ProtoField, ScalarType } from '../../core';

// ── 320011 语音 ─────────────────────────────────────────────────────────────

/** #320011/#320510 —— 语音音色详情。 */
export const BotVoiceDetailWire = {
  /** #320511: 音色 id，与外层 #320501 相同。 */
  voiceId: ProtoField(320511, ScalarType.STRING, { optional: true }),
  /** #320512: 音色名（小Q 的叫「小Q」）。 */
  voiceName: ProtoField(320512, ScalarType.STRING, { optional: true }),
  /** #320513: 音色描述。观测中恒为空。 */
  voiceDesc: ProtoField(320513, ScalarType.STRING, { optional: true }),
  /** #320514: 试听音频 URL（.wav）。 */
  sampleUrl: ProtoField(320514, ScalarType.STRING, { optional: true }),
};

/** 320011 —— 机器人的 TTS 音色。没配语音的机器人只有一个空的 #320501。 */
export const BotVoiceBody = {
  /** #320501: 当前音色 id，如 "lucy-voice-qqfmm1"。空串 = 未启用语音。 */
  voiceId: ProtoField(320501, ScalarType.STRING, { optional: true }),
  /** #320510: 音色详情。 */
  detail: ProtoField(320510, () => BotVoiceDetailWire, { optional: true }),
};

// ── 320014 指令列表 ─────────────────────────────────────────────────────────

/** #320014 —— 一条机器人指令。整列是 repeated，每条独立编码后首尾相接。 */
export const BotCommandWire = {
  /** #320293: 指令 id。 */
  commandId: ProtoField(320293, ScalarType.UINT32, { optional: true }),
  /** #320294: 指令文本，如 "/签到"。 */
  command: ProtoField(320294, ScalarType.STRING, { optional: true }),
  /** #320295: 指令说明，如 "每日签到赚积分兑道具"。 */
  description: ProtoField(320295, ScalarType.STRING, { optional: true }),
  /** #320296: 未知标志。观测中恒为 0。 */
  flag320296: ProtoField(320296, ScalarType.UINT32, { optional: true }),
  /** #320297: 未知字符串。观测中恒为空。 */
  flag320297: ProtoField(320297, ScalarType.STRING, { optional: true }),
};

export const BotCommandListBody = {
  commands: ProtoField(320014, () => BotCommandWire, { repeat: true }),
};

// ── 320065 / 320082 主题 ────────────────────────────────────────────────────
// 两列结构相同：320065 是 AIO 聊天窗背景，320082 是资料卡背景。内层用的是
// 小 tag（1/2/5/6/7），不带列号偏移。

/** #320065/#7 —— 开场白（只有官方 AI 小Q 有）。 */
export const BotGreetingWire = {
  /** #1: 开场白头像。 */
  avatarUrl: ProtoField(1, ScalarType.STRING, { optional: true }),
  /** #2: 开场白头像（副本，观测中与 #1 恒等）。 */
  avatarUrlAlt: ProtoField(2, ScalarType.STRING, { optional: true }),
  /** #3: 主标题，如「你好，有什么能帮你？」。 */
  title: ProtoField(3, ScalarType.STRING, { optional: true }),
  /** #4: 副标题，如「我是你的答疑、搜索、创作小助手」。 */
  subtitle: ProtoField(4, ScalarType.STRING, { optional: true }),
};

/** 320065 / 320082 的共用内层。 */
const BotThemeInnerWire = {
  /** #1: 亮色背景图 URL。 */
  lightBgUrl: ProtoField(1, ScalarType.STRING, { optional: true }),
  /** #2: 暗色背景图 URL。 */
  darkBgUrl: ProtoField(2, ScalarType.STRING, { optional: true }),
  /** #5: 亮色主题色，如 "#F1F1F1"。 */
  lightColor: ProtoField(5, ScalarType.STRING, { optional: true }),
  /** #6: 暗色主题色，如 "#161616"。 */
  darkColor: ProtoField(6, ScalarType.STRING, { optional: true }),
  /** #7: 开场白。 */
  greeting: ProtoField(7, () => BotGreetingWire, { optional: true }),
};

/** 320065 —— AIO 聊天窗主题。 */
export const BotAioThemeBody = {
  theme: ProtoField(320065, () => BotThemeInnerWire, { optional: true }),
};

/** 320082 —— 资料卡主题。 */
export const BotCardThemeBody = {
  theme: ProtoField(320082, () => BotThemeInnerWire, { optional: true }),
};

// ── 320084 隐私规则 ─────────────────────────────────────────────────────────

/** #320084 内层。用小 tag。 */
const BotPrivacyRuleInnerWire = {
  /** #1: 规则页 URL。 */
  url: ProtoField(1, ScalarType.STRING, { optional: true }),
  /** #2: 规则标题，如「《小Q个人信息处理规则》」。 */
  title: ProtoField(2, ScalarType.STRING, { optional: true }),
};

/** 320084 —— 个人信息处理规则链接。 */
export const BotPrivacyRuleBody = {
  rule: ProtoField(320084, () => BotPrivacyRuleInnerWire, { optional: true }),
};
