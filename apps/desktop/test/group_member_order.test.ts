import { describe, expect, it, vi } from 'vitest';
import type { GroupMember } from '@weq/db';
import type { AccountServices } from '../src/main/context/app_context';
import {
  listOrderedGroupMembers,
  startGroupMemberOrderTask,
} from '../src/main/context/group_member_order';
import { backgroundTasks } from '../src/main/background_tasks';
import { watchTaskPage } from '../src/main/task_page';

const member = (uid: string, card: string, memberLevel: number, adminFlag = 0): GroupMember => ({
  groupCode: 12345n,
  uid,
  uin: BigInt(`2000${uid.at(-1)}`),
  card,
  nick: 'QQ 昵称',
  joinTime: memberLevel * 10000,
  lastSpeakTime: memberLevel * 20000,
  muteUntil: 0,
  adminFlag,
  memberFlag: 0,
  customTitle: '',
  memberLevel,
});

const members = [
  member('u_1', '朱', 0),
  member('u_2', '白', 2, 1),
  member('u_3', '方', 10),
  member('u_4', '丁', 8, 1),
  member('u_5', '安', 5),
];
const services = {
  groupInfo: {
    listMembersInGroup: vi.fn(async () => members),
    getGroupDetail: async () => ({ ownerUid: 'u_1' }),
  },
  profile: {
    memberNamesByUids: async () => [{ uid: 'u_5', remark: '本地备注', nick: '其他 QQ 昵称' }],
  },
} as unknown as AccountServices;

const input = {
  groupCode: '12345',
  keyword: '',
  sort: 'displayName',
  descending: false,
  prioritizeAdmins: false,
  limit: 2,
  offset: 0,
} as const;

describe('群成员列表排序', () => {
  it('默认按显示昵称排序且在选取页面前处理整群名单', async () => {
    const page = await listOrderedGroupMembers(services, input);
    expect(page.total).toBe(5);
    expect(page.members.map(({ displayName, sortDetail }) => [displayName, sortDetail])).toEqual([
      ['安', null],
      ['白', null],
    ]);
    expect(
      (await listOrderedGroupMembers(services, { ...input, offset: 2 })).members.map(
        ({ displayName }) => displayName,
      ),
    ).toEqual(['丁', '方']);
  });

  it('置顶先分群主和管理员，搜索及排序方向在分页前生效', async () => {
    const first = await listOrderedGroupMembers(services, {
      ...input,
      sort: 'memberLevel',
      descending: true,
      prioritizeAdmins: true,
    });
    expect(first.members.map(({ member, sortDetail }) => [member.uid, sortDetail?.text])).toEqual([
      ['u_1', '未读取'],
      ['u_4', 'Lv8'],
    ]);

    const second = await listOrderedGroupMembers(services, {
      ...input,
      sort: 'memberLevel',
      descending: true,
      prioritizeAdmins: true,
      offset: 2,
    });
    expect(second.members.map(({ member }) => member.uid)).toEqual(['u_2', 'u_3']);

    const matches = await listOrderedGroupMembers(services, {
      ...input,
      keyword: '2000',
      sort: 'memberLevel',
      offset: 4,
    });
    expect(matches.total).toBe(5);
    expect(matches.members[0]?.member.uid).toBe('u_1');
  });
});

it.each([false, true])('补取排序资料结束前离开才显示任务（中途离开：%s）', async (leavesEarly) => {
  const gate = Promise.withResolvers<GroupMember[]>();
  const source = {
    groupInfo: { listMembersInGroup: () => gate.promise },
    contactDirectory: { cache: { rowsFor: async () => ({}) } },
  } as unknown as AccountServices;
  let pageId: string | undefined;
  const page = watchTaskPage().subscribe({
    next: (id) => {
      pageId = id;
    },
  });
  const id = startGroupMemberOrderTask(
    source,
    { uin: '10001', configId: 'synthetic' },
    '12345',
    'level',
    () => {},
    pageId,
  );
  const task = () => backgroundTasks.snapshot().find((row) => row.id === id);
  try {
    expect(task()).toMatchObject({ status: 'running', foreground: true });
    if (leavesEarly) page.unsubscribe();
    gate.resolve([]);
    await vi.waitFor(() => expect(task()?.status).toBe('completed'));
    page.unsubscribe();
    expect(task()?.foreground).toBe(!leavesEarly);
  } finally {
    gate.resolve([]);
    page.unsubscribe();
    backgroundTasks.remove(id);
  }
});
