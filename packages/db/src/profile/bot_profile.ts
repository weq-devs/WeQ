/**
 * `profile_info_adelie` — QQ 机器人档案（QQ 内部把机器人叫 "adelie"）。
 *
 * 这张表是**懒填充的缓存**：只有在客户端拉过某个机器人的资料卡后才会有行。
 * 所以它不能当作「这个 uid 是机器人」的判据 —— 那个判据在 `profile_info_v6`
 * 的 21000 列里（见 `ProfileInfoDb.botUids`）。本类只负责把已缓存的档案读出来。
 *
 * Column map（本类读取的部分）：
 *   1000   uid             (TEXT)
 *   1002   uin             (INTEGER)
 *   320001 nick            (TEXT)
 *   320002 avatarUrl       (TEXT)
 *   320003 description     (TEXT)   机器人简介
 *   320004 welcome         (TEXT)   欢迎语
 *   320007 wakeCommand     (TEXT)   唤醒指令，如 "@QQ"
 *   320011 voice           (BLOB)   TTS 音色
 *   320014 commands        (BLOB)   指令列表（repeated）
 *   320065 aioTheme        (BLOB)   聊天窗背景 + 开场白
 *   320068 themeColor      (TEXT)   主题色 "#1E74FF"
 *   320082 cardTheme       (BLOB)   资料卡背景
 *   320084 privacyRule     (BLOB)   个人信息处理规则链接
 *
 * 未解读的列：320066（功能面板配置）、320086（模型灰度配置）—— 都是小Q 专属的
 * 运营配置，对展示机器人资料没有价值。
 */

import { ProtoMsg } from '@weq/codec';
import {
  BotAioThemeBody,
  BotCardThemeBody,
  BotCommandListBody,
  BotPrivacyRuleBody,
  BotVoiceBody,
} from '@weq/codec/proto/profile/adelie';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const voiceCodec = new ProtoMsg(BotVoiceBody);
const commandsCodec = new ProtoMsg(BotCommandListBody);
const aioThemeCodec = new ProtoMsg(BotAioThemeBody);
const cardThemeCodec = new ProtoMsg(BotCardThemeBody);
const privacyCodec = new ProtoMsg(BotPrivacyRuleBody);

/** 一条机器人指令。 */
export interface BotCommand {
  id: number;
  command: string;
  description: string;
}

/** 机器人 TTS 音色。 */
export interface BotVoice {
  id: string;
  name: string;
  /** 试听音频 URL。 */
  sampleUrl: string;
}

/** 聊天窗 / 资料卡背景主题。 */
export interface BotTheme {
  lightBgUrl?: string;
  darkBgUrl?: string;
  lightColor?: string;
  darkColor?: string;
}

/** 开场白（目前只有官方 AI 小Q 有）。 */
export interface BotGreeting {
  avatarUrl?: string;
  title?: string;
  subtitle?: string;
}

export interface BotProfile {
  uid: string;
  uin: bigint;
  nick: string;
  avatarUrl: string;
  /** 机器人简介。 */
  description: string;
  /** 入群/加好友欢迎语。 */
  welcome: string;
  /** 唤醒指令，如 "@QQ"。 */
  wakeCommand: string;
  /** 主题色，如 "#1E74FF"。 */
  themeColor: string;
  commands: BotCommand[];
  voice?: BotVoice;
  greeting?: BotGreeting;
  aioTheme?: BotTheme;
  cardTheme?: BotTheme;
  privacyRule?: { url: string; title: string };
}

export interface BotProfileDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"1000","1002","320001","320002","320003","320004","320007","320011","320014","320065","320068","320082","320084"`;

export class BotProfileDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: BotProfileDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  async getBotProfile(uid: string): Promise<BotProfile | null> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM profile_info_adelie WHERE "1000" = ? LIMIT 1`,
      [uid],
    );
    const row = rows[0];
    return row ? rowToBotProfile(row) : null;
  }

  async listBotProfiles(): Promise<BotProfile[]> {
    const rows = await this.qq.query(`SELECT ${SELECT_COLUMNS} FROM profile_info_adelie`);
    return rows.map(rowToBotProfile);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToBotProfile(row: SqlRow): BotProfile {
  return {
    uid: String(row[0] ?? ''),
    uin: toBigint(row[1]),
    nick: String(row[2] ?? ''),
    avatarUrl: String(row[3] ?? ''),
    description: String(row[4] ?? ''),
    welcome: String(row[5] ?? ''),
    wakeCommand: String(row[6] ?? ''),
    voice: parseVoice(row[7]),
    commands: parseCommands(row[8]),
    aioTheme: parseTheme(row[9], aioThemeCodec),
    greeting: parseGreeting(row[9]),
    themeColor: String(row[10] ?? ''),
    cardTheme: parseTheme(row[11], cardThemeCodec),
    privacyRule: parsePrivacyRule(row[12]),
  };
}

function parseVoice(blob: SqlValue | undefined): BotVoice | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const body = voiceCodec.decode(blob);
    // 未启用语音的机器人写的是一个空的 #320501，没有 #320510。
    if (!body.voiceId) return undefined;
    return {
      id: body.voiceId,
      name: body.detail?.voiceName ?? '',
      sampleUrl: body.detail?.sampleUrl ?? '',
    };
  } catch {
    return undefined;
  }
}

function parseCommands(blob: SqlValue | undefined): BotCommand[] {
  if (!(blob instanceof Uint8Array)) return [];
  try {
    return (commandsCodec.decode(blob).commands ?? [])
      .filter((c) => c.command)
      .map((c) => ({
        id: c.commandId ?? 0,
        command: c.command ?? '',
        description: c.description ?? '',
      }));
  } catch {
    return [];
  }
}

function parseTheme(
  blob: SqlValue | undefined,
  codec: ProtoMsg<typeof BotAioThemeBody> | ProtoMsg<typeof BotCardThemeBody>,
): BotTheme | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const t = codec.decode(blob).theme;
    if (!t) return undefined;
    const theme: BotTheme = {
      lightBgUrl: t.lightBgUrl || undefined,
      darkBgUrl: t.darkBgUrl || undefined,
      lightColor: t.lightColor || undefined,
      darkColor: t.darkColor || undefined,
    };
    return theme.lightBgUrl || theme.darkBgUrl || theme.lightColor ? theme : undefined;
  } catch {
    return undefined;
  }
}

function parseGreeting(blob: SqlValue | undefined): BotGreeting | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const g = aioThemeCodec.decode(blob).theme?.greeting;
    if (!g?.title) return undefined;
    return {
      avatarUrl: g.avatarUrl || undefined,
      title: g.title,
      subtitle: g.subtitle || undefined,
    };
  } catch {
    return undefined;
  }
}

function parsePrivacyRule(blob: SqlValue | undefined): { url: string; title: string } | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const r = privacyCodec.decode(blob).rule;
    if (!r?.url) return undefined;
    return { url: r.url, title: r.title ?? '' };
  } catch {
    return undefined;
  }
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}
