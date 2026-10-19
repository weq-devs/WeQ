/**
 * 联系人导出器 —— 导出**好友列表**或**某群的成员列表**为 json / jsonl / csv / xlsx /
 * txt（好友额外支持 vcard 电子名片）。
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
  /** 分页拉群资料目录；旧调用方仅导出好友／成员时可不提供。 */
  listGroups?: (limit: number, offset: number) => Promise<GroupDirectoryRow[]>;
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
      /** 21000 列扩展资料（特权/所在地/教育/兴趣/空间相册）；未缓存时缺省。 */
      extInfo?: {
        privileges: Array<{ bizId?: number; level?: number; opened: boolean }>;
        school?: string;
        degree?: string;
        country?: string;
        province?: string;
        city?: string;
        interests: string[];
        album: Array<{
          photoId?: string;
          time?: number;
          urls: Array<{ size?: number; url?: string }>;
        }>;
      };
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

export interface ContactsExportSelection {
  scope: 'friends' | 'group' | 'groups';
  categoryIds?: number[];
  uids?: string[];
  groupIds?: string[];
}

export interface GroupDirectoryRow {
  groupCode: string;
  groupName: string;
  remark: string;
  memberCount: number;
  maxMemberCount: number;
  ownerUid: string;
  createTime: number;
  leaveFlag: number;
}

const GROUP_COLS: Array<Col<GroupDirectoryRow>> = [
  { key: 'groupCode', header: '群号', get: (r) => r.groupCode },
  { key: 'groupName', header: '群名称', get: (r) => r.groupName },
  { key: 'remark', header: '群备注', get: (r) => r.remark },
  { key: 'memberCount', header: '成员数', get: (r) => r.memberCount },
  { key: 'maxMemberCount', header: '人数上限', get: (r) => r.maxMemberCount },
  { key: 'ownerUid', header: '群主UID', get: (r) => r.ownerUid },
  { key: 'createTime', header: '创建时间（北京时间）', get: (r) => timeText(r.createTime) },
  { key: 'leaveFlag', header: '离群标记', get: (r) => r.leaveFlag },
];

export async function collectGroupDirectory(
  opts: {
    groupIds?: string[];
    signal?: AbortSignal;
    onProgress?: (current: number, total: number, note: string) => void;
  },
  deps: ContactsExportDeps,
): Promise<GroupDirectoryRow[]> {
  if (!deps.listGroups) throw new Error('群聊名单读取能力不可用。');
  const groups = new Map<string, GroupDirectoryRow>();
  for (let page = 0; ; page++) {
    opts.signal?.throwIfAborted();
    if (page >= MAX_PAGES) throw new Error('群聊目录超过分页上限，未导出不完整名单。');
    const batch = await deps.listGroups(GROUP_DIRECTORY_PAGE, page * GROUP_DIRECTORY_PAGE);
    opts.signal?.throwIfAborted();
    for (const row of batch) groups.set(row.groupCode, { ...row });
    opts.onProgress?.(groups.size, groups.size, `已获取 ${groups.size} 个群聊`);
    opts.signal?.throwIfAborted();
    if (batch.length < GROUP_DIRECTORY_PAGE) break;
  }
  const all = [...groups.values()];
  if (opts.groupIds === undefined) return all;
  const wanted = new Set(opts.groupIds);
  if ([...wanted].some((id) => !groups.has(id)))
    throw new Error('部分选中的群聊已不在本地目录中，请刷新后重试。');
  return all.filter((row) => wanted.has(row.groupCode));
}

export async function writeGroupDirectory(
  rows: GroupDirectoryRow[],
  format: Exclude<ContactsFormat, 'vcard'>,
  outputPath: string,
): Promise<void> {
  await writeTable(format, GROUP_COLS, rows, outputPath, '群聊名单');
}

/** 联系人导出格式。 */
const CONTACT_FORMATS = ['json', 'jsonl', 'csv', 'xlsx', 'txt', 'vcard'] as const;
export type ContactsFormat = (typeof CONTACT_FORMATS)[number];

export function normaliseContactsFormats(
  formats: readonly string[],
  group: boolean,
): ContactsFormat[] {
  const result = new Set<ContactsFormat>();
  for (const format of formats) {
    if (!(CONTACT_FORMATS as readonly string[]).includes(format))
      throw new Error(`联系人导出不支持 ${format} 格式。`);
    result.add(group && format === 'vcard' ? 'csv' : (format as ContactsFormat));
  }
  return [...result];
}

export interface ContactsExportResult {
  filePath: string;
  /** 写入的联系人条数。 */
  count: number;
}

const BUDDY_PAGE = 1000;
const MEMBER_PAGE = 1000;
export const GROUP_DIRECTORY_PAGE = 1000;
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

const CONTACT_TIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 秒级时间戳按北京时间显示；超出日期范围的值原样保留，不伪造日期。 */
function timeText(sec: number): string {
  if (!sec) return '';
  const date = new Date(sec * 1000);
  return Number.isFinite(date.getTime()) ? CONTACT_TIME.format(date) : String(sec);
}

/** 特权 bizId → 名称（同资料卡片；未知 id 退化成「特权 N」）。 */
const PRIVILEGE_NAMES: Record<number, string> = {
  1: '超级会员',
  102: '黄钻',
  103: '音乐包',
  113: '大会员',
  118: '绿钻',
  119: '情侣特权',
};

/** 已开通特权 → `超级会员6级 / 音乐包2级`。 */
function privilegeText(items: Array<{ bizId?: number; level?: number; opened: boolean }>): string {
  return items
    .filter((p) => p.opened)
    .map((p) => {
      const name = p.bizId == null ? '特权' : (PRIVILEGE_NAMES[p.bizId] ?? `特权${p.bizId}`);
      return p.level ? `${name}${p.level}级` : name;
    })
    .join(' / ');
}

/** 国/省/市三级去重拼接。 */
function regionText(parts: Array<string | undefined>): string {
  const out: string[] = [];
  for (const part of parts) {
    const value = part?.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out.join(' ');
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
  /** 已开通特权（`超级会员6级 / 音乐包2级`）。 */
  privileges: string;
  /** 所在地（国 省 市，去重拼接）。 */
  region: string;
  /** 所在地三段原值（vCard 的 ADR 需要分开填）。 */
  country: string;
  province: string;
  city: string;
  /** 教育经历（学校 · 学历）。 */
  education: string;
  /** 个性标签。 */
  interests: string;
  /** 空间相册张数。 */
  albumCount: number;
  /** 空间相册图片直链（640 档，换行分隔）。 */
  albumUrls: string;
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
  {
    key: 'birthday',
    header: '生日',
    get: (r) => birthdayText(r.birthYear, r.birthMonth, r.birthDay),
  },
  { key: 'intimacy', header: '亲密度', get: (r) => (r.intimacy > 0 ? r.intimacy : '') },
  { key: 'privileges', header: '特权', get: (r) => r.privileges },
  { key: 'region', header: '所在地', get: (r) => r.region },
  { key: 'education', header: '教育经历', get: (r) => r.education },
  { key: 'interests', header: '个性标签', get: (r) => r.interests },
  { key: 'albumCount', header: '空间相册数', get: (r) => (r.albumCount > 0 ? r.albumCount : '') },
  { key: 'albumUrls', header: '空间相册链接', get: (r) => r.albumUrls },
  { key: 'uid', header: 'uid', get: (r) => r.uid },
];

export interface ExportFriendsOpts {
  format: ContactsFormat;
  outputPath: string;
  /** 只导出这些分组 id（空 / 省略 = 全部好友）。 */
  categoryIds?: number[];
  /** 精确好友身份；省略表示按条件，空集合仅表示零条。 */
  uids?: string[];
  /** 出现过的好友 uin（供头像阶段下载），传入则填充。 */
  collectUins?: Set<string>;
  onProgress?: (current: number, total: number, note: string) => void;
  signal?: AbortSignal;
}

function exactContacts<T extends { uid: string }>(
  rows: T[],
  uids: readonly string[] | undefined,
): T[] {
  if (uids === undefined) return rows;
  const wanted = new Set(uids);
  const selected = rows.filter((row) => wanted.has(row.uid));
  const present = new Set(selected.map((row) => row.uid));
  if ([...wanted].some((uid) => !present.has(uid)))
    throw new Error('部分选中的联系人已不在当前本地列表中，请刷新后重试。');
  return selected;
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

/** 读取一次好友快照，供同一任务的多种格式共用。 */
export async function collectFriends(
  opts: Omit<ExportFriendsOpts, 'format' | 'outputPath'>,
  deps: ContactsExportDeps,
): Promise<FriendRow[]> {
  opts.signal?.throwIfAborted();
  opts.onProgress?.(0, 0, '拉取好友…');
  let buddies = await fetchAllBuddies(deps, opts.signal);
  opts.signal?.throwIfAborted();
  if (opts.categoryIds && opts.categoryIds.length > 0) {
    const wanted = new Set(opts.categoryIds);
    buddies = buddies.filter((b) => wanted.has(b.categoryId));
  }
  buddies = exactContacts(buddies, opts.uids);

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
    const ext = p?.extInfo;
    const album = ext?.album ?? [];
    return {
      uin: b.uin,
      nick: p?.nick ?? '',
      remark: p?.remark ?? '',
      category:
        categoryName.get(b.categoryId) ?? (b.categoryId ? `分组${b.categoryId}` : '我的好友'),
      signature: p?.signature ?? '',
      gender: p?.gender ?? 0,
      age: p?.age ?? 0,
      birthYear: p?.birthYear ?? 0,
      birthMonth: p?.birthMonth ?? 0,
      birthDay: p?.birthDay ?? 0,
      intimacy: p?.intimacy ?? 0,
      privileges: privilegeText(ext?.privileges ?? []),
      region: regionText([ext?.country, ext?.province, ext?.city]),
      country: ext?.country?.trim() ?? '',
      province: ext?.province?.trim() ?? '',
      city: ext?.city?.trim() ?? '',
      education: [ext?.school?.trim(), ext?.degree?.trim()].filter(Boolean).join(' · '),
      interests: (ext?.interests ?? []).filter((t) => t.trim()).join(' / '),
      albumCount: album.length,
      // 640 档够看且体积可控，缺这档时退回任意一档。
      albumUrls: album
        .map(
          (ph) =>
            ph.urls.find((u) => u.size === 2 && u.url)?.url ?? ph.urls.find((u) => u.url)?.url,
        )
        .filter(Boolean)
        .join('\n'),
      uid: b.uid,
    };
  });

  opts.onProgress?.(rows.length, rows.length, `${rows.length} 位好友`);
  opts.signal?.throwIfAborted();
  return rows;
}

export async function writeFriends(
  rows: FriendRow[],
  format: ContactsFormat,
  outputPath: string,
): Promise<void> {
  if (format === 'vcard') {
    await writeFriendsVcard(rows, outputPath);
  } else {
    await writeTable(format, FRIEND_COLS, rows, outputPath, '好友');
  }
}

/** 单格式调用保留原有接口。 */
export async function exportFriends(
  opts: ExportFriendsOpts,
  deps: ContactsExportDeps,
): Promise<ContactsExportResult> {
  const rows = await collectFriends(opts, deps);
  opts.signal?.throwIfAborted();
  await writeFriends(rows, opts.format, opts.outputPath);
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
      r.privileges ? `特权: ${r.privileges}` : '',
      r.interests ? `个性标签: ${r.interests}` : '',
      `QQ: ${r.uin}`,
    ].filter(Boolean);
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${escapeVcard(display)}`,
      `N:${escapeVcard(r.nick || display)};;;;`,
      r.nick ? `NICKNAME:${escapeVcard(r.nick)}` : '',
      // vCard ADR 是 `;;街道;市;省;邮编;国` 七段，这里只有省/市/国三段有值。
      r.region
        ? `ADR;TYPE=HOME:;;;${escapeVcard(r.city)};${escapeVcard(r.province)};;${escapeVcard(r.country)}`
        : '',
      r.education ? `ORG:${escapeVcard(r.education)}` : '',
      `NOTE:${escapeVcard(noteParts.join('\n'))}`,
      `X-QQ:${escapeVcard(r.uin)}`,
      r.gender ? `GENDER:${r.gender === 1 ? 'M' : 'F'}` : '',
      'END:VCARD',
    ].filter(Boolean);
    return lines.join('\r\n');
  });
  await writeFileStream(outputPath, `${cards.join('\r\n')}\r\n`);
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
  uids?: string[];
  collectUins?: Set<string>;
  onProgress?: (current: number, total: number, note: string) => void;
  signal?: AbortSignal;
}

export async function collectGroupMembers(
  opts: Omit<ExportGroupMembersOpts, 'format' | 'outputPath'>,
  deps: ContactsExportDeps,
): Promise<MemberRow[]> {
  opts.signal?.throwIfAborted();
  opts.onProgress?.(0, 0, '拉取群成员…');
  const members: Awaited<ReturnType<ContactsExportDeps['listGroupMembers']>> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (opts.signal?.aborted) break;
    const batch = await deps.listGroupMembers(opts.groupCode, MEMBER_PAGE, page * MEMBER_PAGE);
    members.push(...batch);
    opts.onProgress?.(members.length, members.length, `已获取 ${members.length} 位`);
    if (batch.length < MEMBER_PAGE) break;
  }

  opts.signal?.throwIfAborted();
  const selected = exactContacts(members, opts.uids);
  const ownerUid = selected.length
    ? await deps.groupOwnerUid(opts.groupCode).catch(() => null)
    : null;

  const rows: MemberRow[] = selected.map((m) => {
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
  opts.signal?.throwIfAborted();
  return rows;
}

export async function writeGroupMembers(
  rows: MemberRow[],
  format: Exclude<ContactsFormat, 'vcard'>,
  outputPath: string,
): Promise<void> {
  await writeTable(format, MEMBER_COLS, rows, outputPath, '群成员');
}

export async function exportGroupMembers(
  opts: ExportGroupMembersOpts,
  deps: ContactsExportDeps,
): Promise<ContactsExportResult> {
  const rows = await collectGroupMembers(opts, deps);
  opts.signal?.throwIfAborted();
  await writeGroupMembers(rows, opts.format, opts.outputPath);
  return { filePath: opts.outputPath, count: rows.length };
}
