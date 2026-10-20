/**
 * `group_todo_top_banner` — 群待办（顶部横幅）的本地缓存。
 *
 * Column map:
 *   48901  groupCode       (INTEGER — 一个群一行)
 *   48902  banner          (BLOB/Protobuf — 见 `@weq/codec/proto/group_info/todo`)
 *
 * 这张表**可能不存在**：只有真正用过群待办的账号 / 版本才会建它。表缺失、或者
 * 某一行只是「已消失」的占位（`bannerType = 0` + `isDisappear = true`，内容字段
 * 全空），都按「这个群没有待办」处理，返回空数组而不是报错。
 *
 * 表里只有**横幅摘要**（`[图片]` / `[文件]名字` / 正文前若干字），原消息的完整
 * element 不在这里 —— 那要靠 `jumpInfo.jumpParam` 里的 seq/random 去
 * `nt_msg.db → group_msg_table` 取。组合逻辑在 service 层
 * （`GroupInfoService.getGroupTodos`）。
 */

import { ProtoMsg } from '@weq/codec';
import { GroupTodoTopBannerColumn } from '@weq/codec/proto/group_info/todo';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const todoCodec = new ProtoMsg(GroupTodoTopBannerColumn);

const TABLE = 'group_todo_top_banner';

/** 群待办的 `bizType`（`banner.1`）。 */
export const TODO_BIZ_TYPE_GROUP = 15;

/** 跳转类型（`commonBanner.jumpInfo.jumpType`）—— 3 = 跳到原消息。 */
export const TODO_JUMP_TYPE_MESSAGE = 3;

export interface GroupTodo {
  /** 群号（48901）。 */
  groupCode: string;
  /** 原消息的 msgSeq —— `msgId` 前缀 / `jumpParam.seq` / `inner.3` 三处一致。 */
  msgSeq: bigint;
  /** 原消息的 msgRandom —— `msgId` 后缀 / `jumpParam.random`。没有时为 0。 */
  msgRandom: bigint;
  /** 横幅正文摘要：`[图片]`、`[文件]名字`、纯文本、链接…… */
  text: string;
  /** 前缀文案（实测恒为「群待办｜」）。 */
  preText: string;
  /** 左侧图标 URL。 */
  iconUrl: string;
  /** 跳转类型（3 = 跳到原消息）。 */
  jumpType: number;
  /** 跳转参数原文（JSON `{"seq":…,"random":…}`）。 */
  jumpParam: string;
  /** 创建时间（unix 秒）。 */
  createTime: number;
  /** 更新时间（unix 秒）。 */
  updateTime: number;
  /** 过期时间（unix 秒，0 = 不过期）。 */
  expireTime: number;
  /** 横幅类型（2 = 待办，0 = 占位）。 */
  bannerType: number;
}

export interface GroupTodoDbOptions {
  dbPath: string;
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

const SELECT_COLUMNS = `"48901","48902"`;

export class GroupTodoDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: GroupTodoDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * 表是否存在。缺表 = 这个账号没用过群待办，不是错误。
   *
   * 开库失败（文件不存在 / 密钥不对）也走这里返回 false —— 调用方本来就把
   * 「读不到」和「没有」当成同一件事。
   */
  private async tableExists(): Promise<boolean> {
    try {
      const rows = await this.qq.query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [TABLE],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /** 全部群当前有效的待办（已消失的占位行不算）。表缺失时返回空数组。 */
  async listAll(): Promise<GroupTodo[]> {
    if (!(await this.tableExists())) return [];
    const rows = await this.qq.query(`SELECT ${SELECT_COLUMNS} FROM ${TABLE}`);
    return rows.map(rowToTodo).filter((todo): todo is GroupTodo => todo !== null);
  }

  /** 某个群当前有效的待办；没有 / 表缺失时为 `null`。 */
  async getForGroup(groupCode: bigint | string): Promise<GroupTodo | null> {
    if (!(await this.tableExists())) return null;
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE "48901" = ? LIMIT 1`,
      [typeof groupCode === 'bigint' ? groupCode : BigInt(groupCode)],
    );
    const row = rows[0];
    return row ? rowToTodo(row) : null;
  }

  close(): void {
    this.qq.close();
  }
}

/** 一行 → 待办；占位 / 解不出 / 不是群待办的一律 `null`。 */
function rowToTodo(row: SqlRow): GroupTodo | null {
  const groupCode = toBigint(row[0]);
  if (groupCode <= 0n) return null;

  const blob = row[1];
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return null;

  let inner: ReturnType<typeof todoCodec.decode>['info'];
  try {
    inner = todoCodec.decode(blob).info;
  } catch {
    return null;
  }
  const banner = inner?.banner;
  if (!banner) return null;
  // 已消失的占位行：QQ 在取消/完成后保留行，把内容清空并打上 isDisappear。
  if (banner.isDisappear === true) return null;
  // 只认群待办横幅；其它 bizType 的 banner 以后可能复用这张表。
  if (banner.bizType !== undefined && banner.bizType !== TODO_BIZ_TYPE_GROUP) return null;

  const common = banner.commonBanner;
  const ui = common?.ui;
  const jump = common?.jumpInfo;
  const legacy = banner.todoBanner;

  const msgId = banner.msgId ?? '';
  const parsedId = parseMsgId(msgId);
  const parsedParam = parseJumpParam(jump?.jumpParam ?? '');
  const msgSeq = parsedId.seq ?? parsedParam.seq ?? inner?.msgSeq ?? 0n;
  const msgRandom = parsedId.random ?? parsedParam.random ?? 0n;

  // 正文优先新式 ui.text，退回旧式 todoBanner.text（与 0x9474 的解析口径一致）。
  const text = ui?.text || legacy?.text || '';
  // 没有消息标识也没有正文 —— 不是一条能用的待办。
  if (msgSeq === 0n && text === '') return null;

  return {
    groupCode: groupCode.toString(),
    msgSeq,
    msgRandom,
    text,
    preText: ui?.preText ?? '',
    iconUrl: ui?.iconUrl ?? '',
    jumpType: jump?.jumpType ?? 0,
    jumpParam: jump?.jumpParam ?? '',
    createTime: Number(common?.createTime ?? 0n),
    updateTime: Number(common?.updateTime ?? 0n),
    expireTime: Number(banner.expireTime ?? 0n),
    bannerType: banner.bannerType ?? 0,
  };
}

/** `"{seq}_{random}"` → 两段整数；格式不符返回空对象。 */
function parseMsgId(msgId: string): { seq?: bigint; random?: bigint } {
  const m = /^([1-9]\d*)_(-?\d+)$/.exec(msgId);
  if (!m?.[1] || m[2] === undefined) return {};
  try {
    return { seq: BigInt(m[1]), random: BigInt(m[2]) };
  } catch {
    return {};
  }
}

/** `{"seq":30191,"random":0}` → 两段整数；坏 JSON / 缺字段返回空对象。 */
function parseJumpParam(param: string): { seq?: bigint; random?: bigint } {
  if (!param) return {};
  try {
    const parsed = JSON.parse(param) as { seq?: unknown; random?: unknown };
    const out: { seq?: bigint; random?: bigint } = {};
    if (typeof parsed.seq === 'number' || typeof parsed.seq === 'string') {
      out.seq = BigInt(parsed.seq);
    }
    if (typeof parsed.random === 'number' || typeof parsed.random === 'string') {
      out.random = BigInt(parsed.random);
    }
    return out;
  } catch {
    return {};
  }
}

function toBigint(v: SqlValue | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}
