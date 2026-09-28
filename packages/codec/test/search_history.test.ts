/**
 * search_history.100211 — 6 real rows pulled from a live `nt_msg.db`.
 *
 * These are the exact bytes the WeQ MCP `execute_sql` returned, covering every
 * shape observed so far: 好友命中 ×3, 群聊命中 ×1, 群成员命中 ×1, 文件命中 ×1.
 * The tests pin both the per-kind structure (which container / which entity
 * schema) and the cross-row invariant that the stored highlight really is a
 * (case-folded) prefix of the entity's display name — that invariant is the
 * evidence behind naming 100135/100136/100338 a match range + matched text.
 *
 * Verified against the live account via `get_user_profile` / `search_buddies` /
 * `get_group_info` / `search_in_conversation` (2026-09-29): 1002 is the uin and
 * 1001 the qid of the uid in 1000; the group's 60001/60007/60006 match the real
 * 群号 / 群名 / 成员数; the file hit's sendTime/msgId/fileSize/fileMd5/fileToken
 * match the source message's own row + its 40800 file element.
 */

import { describe, expect, it } from 'vitest';
import { ProtoMsg } from '../src/core';
import { SearchHistoryBody } from '../src/proto/msg/search_history';

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const codec = new ProtoMsg(SearchHistoryBody);
const decode = (hex: string) => codec.decode(bytes(hex)).entry!;

/** 群文件命中：群「微波工程计算机设计方法26」里的 习题_第二章.pdf。 */
const FILE_HIT_HEX =
  '9AF730E805A0F73004EAF730DF05CAAF33D205C23E18755F6C453053544F616D' +
  '306E545F434A637565556432374192E20904596F6E67CAE20900D0C41302AAC5' +
  '130A31313039383334303033AAC5130A3131303938333430303388A61D93F29A' +
  '910488A61D93F29A9104BAA61D23E5BEAEE6B3A2E5B7A5E7A88BE8AEA1E7AE97' +
  'E69CBAE8AEBEE8AEA1E696B9E6B3953236D2A71D009AA01F1FE5BEAEE6B3A2E5' +
  'B7A5E7A88BE8AEA1E7AE97E69CBA2DE5BCA0E88081E5B888A2F53012B8F23000' +
  'C0F2300292FF3006E4B9A0E9A2988AD461206631633130393731666132376464' +
  '61303465393133376335303062393935623392D46114E4B9A0E9A2985FE7ACAC' +
  'E4BA8CE7ABA02E70646698D46100A0D46100A8D461E2C90DB0D46100B8D46100' +
  'C0D46102C8D461A3CFBDD506D0D4610CDAD4610C3A3A4E544F5346756C6C3A3A' +
  'E8D46100F2D4610C3A3A4E544F5346756C6C3A3AFAD461133736383737313134' +
  '383839373536383538333982D561133736383737313134383839373536383538' +
  '333888D5610190D5610C98D561D611A0D56193F29A9104AAD561252F63663733' +
  '663165332D613331302D343933632D393265312D623666656336313863623736' +
  'B2D56100BAD56100C0D56100C8D56100D2D56120663830353666363738666638' +
  '6333303238613338353234386330346565663031DAD56100E2D56100E8D561C7' +
  'D6FDD503F0D561C7D6FDD5E39AC2D76AF8D561C7D6FDD5838080800180D66100' +
  '88D6610290D6610298D66102A0D66100A8D661CE91D7A0E39B8FD86AB8D661CE' +
  '91D7A0E39B8FD86AC2D66100CAD66100D2D66100DAD6612DE69DA5E887AAE7BE' +
  'A43AE5BEAEE6B3A2E5B7A5E7A88BE8AEA1E7AE97E69CBAE8AEBEE8AEA1E696B9' +
  'E6B3953236E2D66100E8D66100F0D66100FAD6610082D7610088D7610090D761' +
  '009AD76100B2D76100BAD76100D2D76100D8D76101E0D76100E8D76100F0D761' +
  '66F8D761A3CFBDD50680D86100C8E06100EAE06100F2E0610082E161008AE161' +
  '0092E16100D0AF3300D8AF3300';

/** [100210] → BLOB hex. Row ids are never contiguous: QQ drops evicted rows. */
const SAMPLES = [
  {
    id: 3,
    kind: 'friend' as const,
    hex:
      '9af73078a0f73001caf73070faf13000e0fc3001eafc3064c23e18755f4c4b7433416441494d502d4355666e3679647a447a77' +
      'ca3e076573746b696e6ed03ed18da7d50a92e209066573746b696dcae20900829b0c0ce68891e79a84e5a5bde58f8b' +
      'd0c41301f2f23012b8f23000c0f2300692ff30066573746b696d',
  },
  {
    id: 4,
    kind: 'group' as const,
    hex:
      '9af7308203a0f73002b2f730f902d0c41302faf130066e6f726d616cb2f3305288a61ddfd193da03b0a61d04baa61d0c' +
      'e59b9be9a9b1e5b08fe5ad9090a71d03a0a71d00d2a71d00b8b71d00c0b71d01c8b71d01d8b71d00d2f33012b8f23000' +
      'c0f2300292ff3006e59b9be9a9b1e0a23100faf33018e0c43200e8c43200f2c43200fac4320080c5320088c53200a2a231' +
      'f00167726f75705f696e666f5b703d383220683d315d2c67726f75705f6d656d6265725f696e666f5b703d383120683d30' +
      '5d2c6c6173745f6d73675f74696d655f7370616e5b703d373120683d385d2c67726f75705f6d656d6265725f6e756d5b70' +
      '3d363120683d464646425d2c67726f75705f636865636b5f74696d65735b703d343120683d30303030303030305d2c6c' +
      '6173745f6d73675f74696d655b703d333120683d303030303030303036414141373541375d2c6a6f696e5f67726f7570' +
      '5f74696d655b703d323120683d36364331464243425d2c6d73675f6e6f746966795f666c61675b703d2d3120683d315d' +
      'a8a23100',
  },
  {
    id: 5,
    kind: 'friend' as const,
    hex:
      '9af7308301a0f73001caf7307bfaf13000e0fc3001eafc3067c23e18755f4e4350734e5a77477144646e687a7574656241' +
      '334867ca3e00d03eb1fbca8f0c92e2090fe6b585e7bebde38182e38286e381bfcae20900829b0c0ce68891e79a84e5a5bd' +
      'e58f8bd0c41301f2f2300fb8f23000c0f2300192ff3003e6b585e0a23100a2a23100a8a23100',
  },
  {
    id: 6,
    kind: 'friend' as const,
    hex:
      '9af7308e01a0f73001caf7308501faf13000e0fc3001eafc3071c23e18755f564b764d564e6231794a68416f3252314772' +
      '42306a41ca3e0a54616e7a68697169616fd03e97e8bde20a92e20909e5b08fe69eb3e5a3b3cae20900829b0c0ce68891' +
      'e79a84e5a5bde58f8bd0c41301f2f23015b8f23000c0f2300392ff3009e5b08fe69eb3e5a3b3e0a23100a2a23100a8a23100',
  },
  {
    id: 7,
    kind: 'member' as const,
    hex:
      '9af730b901a0f73001caf730b001faf13000e0fc3002f2fc309b01c23e18755f345f51412d5161467279682d4f63677376' +
      '345f384551d03ebd87c09a0492e20909e5bf98e5bfa7e88d89cae2090088a61deae0d18304baa61d33536e6f774c756d61' +
      '20e8b59be58d9ae7ae97e591bde7bea4207c20e7ad89e5be85e997aee9a298e887aae58aa8e8a7a3e586b3d2a71d009aa01f' +
      '008af43015b8f23000c0f2300392ff3009e5bf98e5bfa7e88d89a0f43000e0a23100a2a23100a8a23100',
  },
  { id: 12, kind: 'file' as const, hex: FILE_HIT_HEX },
] as const;

/** 命中块在四种实体下挂着不同 tag，统一取出来做跨行不变式。 */
function highlightOf(sample: (typeof SAMPLES)[number]) {
  const entry = decode(sample.hex);
  if (sample.kind === 'group') return entry.group?.group?.highlight;
  if (sample.kind === 'member') return entry.person?.groupMember?.highlight;
  if (sample.kind === 'file') return entry.file?.file?.highlight;
  return entry.person?.buddy?.highlight;
}

/** 命中实体的展示名（好友/群友 = 昵称，群 = 群名，文件 = 文件名）。 */
function displayNameOf(sample: (typeof SAMPLES)[number]): string | undefined {
  const entry = decode(sample.hex);
  if (sample.kind === 'group') return entry.group?.group?.groupName;
  if (sample.kind === 'member') return entry.person?.groupMember?.nick;
  if (sample.kind === 'file') return entry.file?.file?.fileName;
  return entry.person?.buddy?.nick;
}

describe('search_history friend hit (100211 / 100217 → 100300=1)', () => {
  it('reads uid / qid / uin / nick / 分组 / 高亮', () => {
    const entry = decode(SAMPLES[0]!.hex);
    expect(entry.resultKind).toBe(1);
    expect(entry.group).toBeUndefined();

    const person = entry.person!;
    expect(person.personKind).toBe(1);
    expect(person.groupMember).toBeUndefined();
    expect(person.scene).toBe('');

    const buddy = person.buddy!;
    expect(buddy.uid).toBe('u_LKt3AdAIMP-CUfn6ydzDzw');
    // 1001 就是资料卡上的 qid：search_buddies 回的是同一个字符串。
    expect(buddy.qid).toBe('estkinn');
    expect(buddy.uin).toBe(2863253201n);
    expect(buddy.nick).toBe('estkim');
    expect(buddy.name).toBe('我的好友');
    expect(buddy.chatType).toBe(1);
    expect(buddy.highlight).toMatchObject({ matchStart: 0, matchLength: 6, matchedText: 'estkim' });
  });
});

describe('search_history group hit (100211 / 100214 → 100150)', () => {
  it('reads 群号 / 群名 / 成员数 / 高亮片段 / 索引描述串', () => {
    const entry = decode(SAMPLES[1]!.hex);
    expect(entry.resultKind).toBe(2);
    expect(entry.person).toBeUndefined();

    const result = entry.group!;
    expect(result.chatType).toBe(2);
    expect(result.scene).toBe('normal');

    const group = result.group!;
    expect(group.groupCode).toBe(994371807n);
    expect(group.groupName).toBe('四驱小子');
    // 与 get_group_info 报的 memberCount 一致 —— 100150.60006 就是人数。
    expect(group.memberCount).toBe(4);
    expect(group.highlight).toMatchObject({ matchStart: 0, matchLength: 2, matchedText: '四驱' });

    // 100900 是 QQ 自己的分段索引描述串；顺序与样本一致。
    expect(result.indexDescriptor).toContain('group_info[p=82 h=1]');
    expect(result.indexDescriptor).toContain('group_member_num[p=61 h=FFFB]');
  });
});

describe('search_history group-member hit (100217 → 100300=2 → 100302)', () => {
  it('reads 群友资料 + 他所在群的群号 / 群名', () => {
    const entry = decode(SAMPLES[4]!.hex);
    expect(entry.resultKind).toBe(1);

    const person = entry.person!;
    expect(person.personKind).toBe(2);
    expect(person.buddy).toBeUndefined();

    const member = person.groupMember!;
    expect(member.uid).toBe('u_4_QA-QaFryh-Ocgsv4_8EQ');
    expect(member.uin).toBe(1129317309n);
    expect(member.nick).toBe('忘忧草');
    expect(member.groupCode).toBe(1081372778n);
    expect(member.groupName).toBe('SnowLuma 赛博算命群 | 等待问题自动解决');
    expect(member.highlight).toMatchObject({
      matchStart: 0,
      matchLength: 3,
      matchedText: '忘忧草',
    });
  });
});

describe('search_history file hit (100211 / 100221 → 105209)', () => {
  it('reads 文件名 / 大小 / 时间 / msgId / 来源群 / 高亮', () => {
    const entry = decode(FILE_HIT_HEX);
    expect(entry.resultKind).toBe(4);
    expect(entry.person).toBeUndefined();
    expect(entry.group).toBeUndefined();

    const result = entry.file!;
    expect(result.flag105210).toBe(0);

    const file = result.file!;
    expect(file.fileName).toBe('习题_第二章.pdf');
    expect(file.fileSize).toBe(222434);
    expect(file.fileMd5).toBe('f8056f678ff8c3028a385248c04eef01');
    expect(file.fileToken).toBe('/cf73f1e3-a310-493c-92e1-b6fec618cb76');
    expect(file.pathRoot).toBe('::NTOSFull::');
    expect(file.sourceLabel).toBe('来自群:微波工程计算机设计方法26');

    // 200009 ≡ 源消息 group_msg_table.[40050]，200015 ≡ 它的 [40001]。
    expect(file.sendTime).toBe(1789880227);
    expect(file.sendTimeCopy).toBe(1789880227);
    expect(file.msgId).toBe('7687711488975685839');

    // 发送者 + 来源群：uid / 昵称 / 群名片 / 群号 / 群名。
    expect(file.uid).toBe('u_lE0STOam0nT_CJcueUd27A');
    expect(file.nick).toBe('Yong');
    expect(file.groupCard).toBe('微波工程计算机-张老师');
    expect(file.chatType).toBe(2);
    expect(file.peerUid).toBe('1109834003');
    expect(file.groupCode).toBe(1109834003n);
    expect(file.groupName).toBe('微波工程计算机设计方法26');

    expect(file.highlight).toMatchObject({ matchStart: 0, matchLength: 2, matchedText: '习题' });
  });
});

describe('search_history cross-row invariants', () => {
  it('every row wraps its payload in field 100211', () => {
    for (const s of SAMPLES) {
      expect(decode(s.hex), `row ${s.id}`).toBeDefined();
    }
  });

  it('matchLength is the highlight length in characters, not bytes', () => {
    for (const s of SAMPLES) {
      const h = highlightOf(s)!;
      expect(h.matchLength, `row ${s.id}`).toBe(h.matchedText!.length);
    }
  });

  it('the highlight is a case-folded prefix of the entity name', () => {
    for (const s of SAMPLES) {
      const h = highlightOf(s)!;
      const name = displayNameOf(s)!;
      expect(name.toLowerCase().startsWith(h.matchedText!.toLowerCase()), `row ${s.id}`).toBe(true);
    }
  });
});
