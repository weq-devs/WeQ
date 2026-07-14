/**
 * 联系人导出器 —— 导出**好友列表**或**某群的成员列表**为 csv / xlsx / json / txt
 * （好友额外支持 vcard 电子名片）。
 *
 * 与消息导出流水线无关：数据来自本地资料库（`buddy_list` / `category_list_v2` /
 * `profile_info_v6` / `group_member3`），一次性拉全后写盘。拉取能力由 deps 注入
 * （service 包不依赖账号服务，照 chatlab / qzone deps 的模式；bigint 在注入侧已
 * 归一化为字符串）。
 *
 * 头像不在这里下载：导出时把出现过的 uin 收进 `collectUins`，由 task_manager 的
 * 「下载头像」阶段复用 {@link import('./avatar_export').exportAvatars} 统一处理，
 * 和消息导出的头像阶段同构（带独立进度条）。
 */

import { writeFileStream, writeTable, type Col } from './table_writer';

/** 注入的联系人数据拉取能力（bigint 已归一化为字符串）。 */
export interface ContactsExportDeps {
  /** 分页拉好友（`buddy_list`）。 */
  listBuddies: (
    limit: number,
    offset: number,
  ) => Promise<Array<{ uid: string; uin: string; qid: string; categoryId: number }>>;
  /** 好友分组（`category_list_v2`）：id → 名称。 */
  listCategories: () => Promise<Array<{ id: number; name: string }>>;
  /** 批量取已缓存资料（`profile_info_v6`）；未缓存的好友不会返回。 */
  profilesByUids: (uids: string[]) => Promise<
    Array<{
      uid: string;
      nick: string;
      remark: string;
      signature: string;
      gender: number;
      age: number;
      birthYear: number;
      birthMonth: number;
      birthDay: number;
      intimacy: number;
    }>
  >;
  /** 分页拉某群成员（`group_member3`）。 */
  listGroupMembers: (
    groupCode: string,
    limit: number,
    offset: number,
  ) => Promise<
    Array<{
      uid: string;
      uin: string;
      card: string;
      nick: string;
      adminFlag: number;
      customTitle: string;
      memberLevel: number;
      joinTime: number;
      lastSpeakTime: number;
    }>
  >;
  /** 群主 uid（用于把角色标成「群主」）；查不到回 null。 */
  groupOwnerUid: (groupCode: string) => Promise<string | null>;
}

/** 联系人导出格式。 */
export type ContactsFormat = 'json' | 'csv' | 'xlsx' | 'txt' | 'vcard';

export interface ContactsExportResult {
  filePath: string;
  /** 写入的联系人条数。 */
  count: number;
}

const BUDDY_PAGE = 1000;
const MEMBER_PAGE = 1000;
const PROFILE_CHUNK = 500;
/** 翻页安全上限，防跑飞。 */
const MAX_PAGES = 200;

// ---- 通用小工具 ----

/** 性别码 → 文字。 */
function genderText(g: number): string {
  return g === 1 ? '男' : g === 2 ? '女' : '';
}

/** 生日三段 → `YYYY-MM-DD`（缺失留空）。 */
function birthdayText(y: number, m: number, d: number): string {
  if (!y && !m && !d) return '';
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${y || 0}-${p(m || 0)}-${p(d || 0)}`;
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm`（0/空留空）。 */
function timeText(sec: number): string {
  if (!sec) return '';
  const date = new Date(sec * 1000);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** vCard 3.0 文本转义（反斜杠/逗号/分号/换行）。 */
function escapeVcard(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// ---- 好友导出 ----

interface FriendRow {
  uin: string;
  nick: string;
  remark: string;
  category: string;
  signature: string;
  gender: number;
  age: number;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  intimacy: number;
  uid: string;
}

const FRIEND_COLS: Array<Col<FriendRow>> = [
  { key: 'uin', header: 'QQ号', get: (r) => r.uin },
  { key: 'nick', header: '昵称', get: (r) => r.nick },
  { key: 'remark', header: '备注', get: (r) => r.remark },
  { key: 'category', header: '分组', get: (r) => r.category },
  { key: 'signature', header: '签名', get: (r) => r.signature },
  { key: 'gender', header: '性别', get: (r) => genderText(r.gender) },
  { key: 'age', header: '年龄', get: (r) => (r.age > 0 ? r.age : '') },
  { key: 'birthday', header: '生日', get: (r) => birthdayText(r.birthYear, r.birthMonth, r.birthDay) },
  { key: 'intimacy', header: '亲密度', get: (r) => (r.intimacy > 0 ? r.intimacy : '') },
  { key: 'uid', header: 'uid', get: (r) => r.uid },
];

export interface ExportFriendsOpts {
  format: ContactsFormat;
  outputPath: string;
  /** 只导出这些分组 id（空 / 省略 = 全部好友）。 */
  categoryIds?: number[];
  /** 出现过的好友 uin（供头像阶段下载），传入则填充。 */
  collectUins?: Set<string>;
  onProgress?: (current: number, total: number, note: string) => void;
  signal?: AbortSignal;
}

/** 拉全好友列表（翻页）。 */
async function fetchAllBuddies(
  deps: ContactsExportDeps,
  signal?: AbortSignal,
): Promise<Array<{ uid: string; uin: string; qid: string; categoryId: number }>> {
  const all: Array<{ uid: string; uin: string; qid: string; categoryId: number }> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) break;
    const batch = await deps.listBuddies(BUDDY_PAGE, page * BUDDY_PAGE);
    all.push(...batch);
    if (batch.length < BUDDY_PAGE) break;
  }
  return all;
}

/** 导出好友列表。 */
export async function exportFriends(
  opts: ExportFriendsOpts,
  deps: ContactsExportDeps,
): Promise<ContactsExportResult> {
  opts.onProgress?.(0, 0, '拉取好友…');
  let buddies = await fetchAllBuddies(deps, opts.signal);
  if (opts.categoryIds && opts.categoryIds.length > 0) {
    const wanted = new Set(opts.categoryIds);
    buddies = buddies.filter((b) => wanted.has(b.categoryId));
  }

  const categories = await deps.listCategories();
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  // 批量补资料（未缓存的以空值兜底）。
  const profileByUid = new Map<
    string,
    Awaited<ReturnType<ContactsExportDeps['profilesByUids']>>[number]
  >();
  const uids = buddies.map((b) => b.uid);
  for (let i = 0; i < uids.length; i += PROFILE_CHUNK) {
    if (opts.signal?.aborted) break;
    const chunk = uids.slice(i, i + PROFILE_CHUNK);
    const profiles = await deps.profilesByUids(chunk);
    for (const p of profiles) profileByUid.set(p.uid, p);
    opts.onProgress?.(Math.min(i + chunk.length, uids.length), uids.length, '补全资料…');
  }

  const rows: FriendRow[] = buddies.map((b) => {
    const p = profileByUid.get(b.uid);
    opts.collectUins?.add(b.uin);
    return {
      uin: b.uin,
      nick: p?.nick ?? '',
      remark: p?.remark ?? '',
      category: categoryName.get(b.categoryId) ?? (b.categoryId ? `分组${b.categoryId}` : '我的好友'),
      signature: p?.signature ?? '',
      gender: p?.gender ?? 0,
      age: p?.age ?? 0,
      birthYear: p?.birthYear ?? 0,
      birthMonth: p?.birthMonth ?? 0,
      birthDay: p?.birthDay ?? 0,
      intimacy: p?.intimacy ?? 0,
      uid: b.uid,
    };
  });

  opts.onProgress?.(rows.length, rows.length, `${rows.length} 位好友`);

  if (opts.format === 'vcard') {
    await writeFriendsVcard(rows, opts.outputPath);
  } else {
    await writeTable(opts.format, FRIEND_COLS, rows, opts.outputPath, '好友');
  }
  return { filePath: opts.outputPath, count: rows.length };
}

/** 好友 → vCard 3.0（一人一张名片）。 */
async function writeFriendsVcard(rows: FriendRow[], outputPath: string): Promise<void> {
  const cards = rows.map((r) => {
    const display = r.remark || r.nick || r.uin;
    const noteParts = [
      r.remark ? `备注: ${r.remark}` : '',
      r.category ? `分组: ${r.category}` : '',
      r.signature ? `签名: ${r.signature}` : '',
      `QQ: ${r.uin}`,
    ].filter(Boolean);
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${escapeVcard(display)}`,
      `N:${escapeVcard(r.nick || display)};;;;`,
      r.nick ? `NICKNAME:${escapeVcard(r.nick)}` : '',
      `NOTE:${escapeVcard(noteParts.join('\n'))}`,
      `X-QQ:${escapeVcard(r.uin)}`,
      r.gender ? `GENDER:${r.gender === 1 ? 'M' : 'F'}` : '',
      'END:VCARD',
    ].filter(Boolean);
    return lines.join('\r\n');
  });
  await writeFileStream(outputPath, cards.join('\r\n') + '\r\n');
}

// ---- 群成员导出 ----

interface MemberRow {
  uin: string;
  card: string;
  nick: string;
  role: string;
  customTitle: string;
  memberLevel: number;
  joinTime: number;
  lastSpeakTime: number;
  uid: string;
}

const MEMBER_COLS: Array<Col<MemberRow>> = [
  { key: 'uin', header: 'QQ号', get: (r) => r.uin },
  { key: 'card', header: '群名片', get: (r) => r.card },
  { key: 'nick', header: '昵称', get: (r) => r.nick },
  { key: 'role', header: '角色', get: (r) => r.role },
  { key: 'title', header: '头衔', get: (r) => r.customTitle },
  { key: 'level', header: '群等级', get: (r) => (r.memberLevel > 0 ? r.memberLevel : '') },
  { key: 'joinTime', header: '入群时间', get: (r) => timeText(r.joinTime) },
  { key: 'lastSpeakTime', header: '最后发言', get: (r) => timeText(r.lastSpeakTime) },
  { key: 'uid', header: 'uid', get: (r) => r.uid },
];

export interface ExportGroupMembersOpts {
  groupCode: string;
  format: Exclude<ContactsFormat, 'vcard'>;
  outputPath: string;
  collectUins?: Set<string>;
  onProgress?: (current: number, total: number, note: string) => void;
  signal?: AbortSignal;
}

/** 导出某群的成员列表。 */
export async function exportGroupMembers(
  opts: ExportGroupMembersOpts,
  deps: ContactsExportDeps,
): Promise<ContactsExportResult> {
  opts.onProgress?.(0, 0, '拉取群成员…');
  const members: Awaited<ReturnType<ContactsExportDeps['listGroupMembers']>> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (opts.signal?.aborted) break;
    const batch = await deps.listGroupMembers(opts.groupCode, MEMBER_PAGE, page * MEMBER_PAGE);
    members.push(...batch);
    opts.onProgress?.(members.length, members.length, `已获取 ${members.length} 位`);
    if (batch.length < MEMBER_PAGE) break;
  }

  const ownerUid = await deps.groupOwnerUid(opts.groupCode).catch(() => null);

  const rows: MemberRow[] = members.map((m) => {
    opts.collectUins?.add(m.uin);
    const role = m.uid && m.uid === ownerUid ? '群主' : m.adminFlag ? '管理员' : '成员';
    return {
      uin: m.uin,
      card: m.card,
      nick: m.nick,
      role,
      customTitle: m.customTitle,
      memberLevel: m.memberLevel,
      joinTime: m.joinTime,
      lastSpeakTime: m.lastSpeakTime,
      uid: m.uid,
    };
  });

  opts.onProgress?.(rows.length, rows.length, `${rows.length} 位成员`);
  await writeTable(opts.format, MEMBER_COLS, rows, opts.outputPath, '群成员');
  return { filePath: opts.outputPath, count: rows.length };
}
