import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  collectFriends,
  collectGroupMembers,
  writeFriends,
  writeGroupMembers,
  writeGroupDirectory,
  type ContactsExportDeps,
} from '../src/account/export/contacts_export';
import ExcelJS from 'exceljs';

function fixture(count = 1) {
  const profilesByUids = vi.fn(async (uids: string[]) =>
    uids
      .filter((id) => id !== 'missing')
      .map((uid) => ({
        uid,
        nick: '缓存昵称',
        remark: '本地备注',
        signature: '本地签名',
        sigUpdateTime: Date.parse('2026-11-10T16:01:02Z') / 1000,
        gender: 0,
        age: 0,
        birthYear: 0,
        birthMonth: 0,
        birthDay: 0,
        intimacy: 0,
        extInfo: {
          occupation: 13,
          bloodType: 5,
          zodiac: 12,
          interactMarks: [{ type: 'fire', markId: 7, iconUrl: 'https://example.test/mark.png' }],
          privileges: [],
          interests: [],
          album: [],
        },
      })),
  );
  const members = Array.from({ length: count }, (_, i) => ({
    uid: i === 1 ? 'missing' : `u_${i}`,
    uin: String(10001 + i),
    card: '群名片',
    nick: '成员昵称',
    adminFlag: 0,
    customTitle: '',
    memberLevel: 1,
    joinTime: 0,
    lastSpeakTime: 0,
  }));
  const deps: ContactsExportDeps = {
    listBuddies: async () => [{ uid: 'u_0', uin: '10001', qid: '', categoryId: 0 }],
    listCategories: async () => [],
    profilesByUids,
    groupOwnerUid: async () => null,
    listGroupMembers: async (_code, limit, offset) => members.slice(offset, offset + limit),
  };
  return { deps, profilesByUids };
}

it('一次快照用于各格式，好友 vCard 与表格追加资料，归档保留原始编号和标识', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-profile-export-'));
  try {
    const { deps, profilesByUids } = fixture();
    const rows = await collectFriends({}, deps);
    for (const format of ['csv', 'txt', 'xlsx', 'vcard', 'json', 'jsonl'] as const) {
      const path = join(root, `friends.${format}`);
      await writeFriends(rows, format, path, { profile: 'full' });
      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path);
        expect(JSON.stringify(workbook.worksheets[0]!.getSheetValues())).toContain(
          '职业（编号 13）',
        );
      } else {
        const text = await readFile(path, 'utf8');
        if (format === 'vcard') {
          expect(text).toContain('TITLE:职业（编号 13）');
          expect(text).toContain('2026-11-11 00:01:02');
        } else if (format === 'json' || format === 'jsonl') {
          expect(text).toContain('occupation');
          expect(text).toContain('interactMarks');
          expect(text).toContain('sigUpdateTime');
        } else {
          expect(text).toContain('血型（编号 5）');
          expect(text).toContain('猪');
          expect(text).toContain('2026-11-11 00:01:02');
        }
      }
    }
    expect(profilesByUids).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('成员仅对选定名单分批补缓存，缺资料不丢身份，完整来源进入归档', async () => {
  const { deps, profilesByUids } = fixture(1001);
  const rows = await collectGroupMembers({ groupCode: '12345' }, deps);
  expect(profilesByUids.mock.calls.map(([uids]) => uids.length)).toEqual([500, 500, 1]);
  expect(rows).toHaveLength(1001);
  expect(rows[1]).toMatchObject({
    uid: 'missing',
    signature: '',
    occupation: '',
    sigUpdateTime: 0,
  });
  expect(rows[0]!.native).toHaveProperty('profile.extInfo.interactMarks');
  profilesByUids.mockClear();
  await collectGroupMembers({ groupCode: '12345', uids: ['u_1000'] }, deps);
  expect(profilesByUids).toHaveBeenCalledWith(['u_1000']);
  const root = await mkdtemp(join(tmpdir(), 'weq-member-export-'));
  try {
    for (const format of ['csv', 'txt', 'xlsx', 'json', 'jsonl'] as const)
      await writeGroupMembers(
        rows.slice(0, 2),
        format,
        join(root, `members.${format}`),
        { profile: 'full' },
        '12345',
      );
    expect(await readFile(join(root, 'members.txt'), 'utf8')).toContain('本地签名');
    expect(await readFile(join(root, 'members.json'), 'utf8')).toContain('interactMarks');
    const labels = [
      { content: '同名', setterUid: 'u_one', setTimestamp: '1794326462' },
      { content: '同名', setterUid: 'u_two', setTimestamp: '9007199254740993123' },
    ];
    const group = {
      groupCode: '12345',
      groupName: '合成群',
      remark: '',
      memberCount: 2,
      maxMemberCount: 200,
      ownerUid: '',
      createTime: 0,
      leaveFlag: 0,
      customLabels: labels,
    };
    await writeGroupDirectory([group], 'txt', join(root, 'groups.txt'));
    expect(await readFile(join(root, 'groups.txt'), 'utf8')).toContain('同名 · 设置者：u_one');
    expect(await readFile(join(root, 'groups.txt'), 'utf8')).toContain('同名 · 设置者：u_two');
    await writeGroupDirectory([group], 'json', join(root, 'groups.json'), { profile: 'full' });
    expect(await readFile(join(root, 'groups.json'), 'utf8')).toContain('9007199254740993123');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('成员缓存补全期间取消，不续读下一批或生成名单', async () => {
  const { deps, profilesByUids } = fixture(501);
  const controller = new AbortController();
  profilesByUids.mockImplementationOnce(async () => {
    controller.abort();
    return [];
  });
  await expect(
    collectGroupMembers({ groupCode: '12345', signal: controller.signal }, deps),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(profilesByUids).toHaveBeenCalledTimes(1);
});

it('没有对应签名时表格和名片不单独显示更新时间，归档仍保留原始时间', async () => {
  const { deps } = fixture();
  const rows = await collectFriends({}, deps);
  rows[0]!.signature = '';
  const root = await mkdtemp(join(tmpdir(), 'weq-empty-signature-'));
  try {
    for (const format of ['csv', 'vcard'] as const) {
      const path = join(root, `friends.${format}`);
      await writeFriends(rows, format, path);
      expect(await readFile(path, 'utf8')).not.toContain('2026-11-11 00:01:02');
    }
    await writeFriends(rows, 'json', join(root, 'friends.json'), { profile: 'full' });
    expect(await readFile(join(root, 'friends.json'), 'utf8')).toContain('sigUpdateTime');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
